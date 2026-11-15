/*
 * OmniSpec — установщик с кнопками.
 *
 * Выглядит как консольный вариант (чёрное окно, моноширинный шрифт, шапка из
 * «=», поля, список «Что будет сделано»), но это обычное окно приложения:
 * пункты меню — настоящие кнопки, путь установки можно ввести в поле, всё
 * закрывается мышью, Enter и Esc работают как раньше.
 */

use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver};
use std::time::Duration;

use eframe::egui;
use egui::{Color32, FontId, RichText, Stroke};

use crate::common::{self, APP_EXE, APP_NAME, STEPS};

/* ───────────────────────── палитра как в консоли ───────────────────────── */

const BG: Color32 = Color32::from_rgb(0x0b, 0x0b, 0x0d);
const TEXT: Color32 = Color32::from_rgb(0xe8, 0xe8, 0xea);
const DIM: Color32 = Color32::from_rgb(0x9a, 0x9a, 0xa2);
const DIM2: Color32 = Color32::from_rgb(0x62, 0x62, 0x6c);
const INV_BG: Color32 = Color32::from_rgb(0xf1, 0xf1, 0xf3);
const INV_FG: Color32 = Color32::from_rgb(0x0a, 0x0a, 0x0c);
const BTN_BG: Color32 = Color32::from_rgb(0x14, 0x14, 0x17);
const BTN_HOVER: Color32 = Color32::from_rgb(0x1e, 0x1e, 0x23);
const BTN_ACTIVE: Color32 = Color32::from_rgb(0x27, 0x27, 0x2d);
const LINE: Color32 = Color32::from_rgb(0x34, 0x34, 0x3a);
const INPUT_BG: Color32 = Color32::from_rgb(0x14, 0x14, 0x17);

const FONT: f32 = 14.0;
const LABEL: usize = 20; // ширина колонки подписи в символах

fn mono(text: impl Into<String>) -> RichText {
    RichText::new(text).font(FontId::monospace(FONT))
}

fn mono_color(text: impl Into<String>, color: Color32) -> RichText {
    mono(text).color(color)
}


/// Мелкая кнопка для окна выбора папки (быстрые места, «вверх», «перейти»).
fn small_button(ui: &mut egui::Ui, label: &str) -> egui::Response {
    ui.add(
        egui::Button::new(
            RichText::new(label)
                .font(FontId::monospace(FONT - 1.0))
                .color(TEXT),
        )
        .min_size(egui::vec2(0.0, 26.0))
        .fill(BTN_BG)
        .stroke(Stroke::new(1.0_f32, LINE)),
    )
}

/// Домашняя папка пользователя — без внешних крейтов, только переменные среды.
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// Быстрые места в окне выбора папки: дом, рабочий стол, загрузки, диски.
fn pick_places() -> Vec<(String, PathBuf)> {
    let mut places: Vec<(String, PathBuf)> = Vec::new();
    if let Some(home) = home_dir() {
        places.push(("домашняя".to_string(), home.clone()));
        for (label, folder) in [("рабочий стол", "Desktop"), ("загрузки", "Downloads")] {
            let path = home.join(folder);
            if path.is_dir() {
                places.push((label.to_string(), path));
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        for letter in 'C'..='Z' {
            let drive = PathBuf::from(format!("{letter}:\\"));
            if drive.exists() {
                places.push((format!("{letter}:"), drive));
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        places.push(("корень".to_string(), PathBuf::from("/")));
        places.push(("usr/local".to_string(), PathBuf::from("/usr/local")));
    }
    places
}

/* ───────────────────────── состояние ───────────────────────── */

#[derive(Clone, Copy, PartialEq)]
enum Screen {
    Offer,
    Installing,
    Done,
    AlreadyInstalled,
    Failed,
}

#[derive(Clone, Copy, PartialEq)]
enum StepState {
    Waiting,
    Running,
    Done,
    Failed,
}

enum Msg {
    Progress(common::Progress),
    Finished(Result<PathBuf, String>),
}

struct Setup {
    dir: PathBuf,
    /// Открыт встроенный выбор папки установки.
    picking: bool,
    pick_dir: PathBuf,
    pick_input: String,
    pick_dirs: Vec<(String, PathBuf)>,
    pick_error: Option<String>,
    screen: Screen,
    steps: Vec<(StepState, String)>,
    rx: Option<Receiver<Msg>>,
    error: Option<String>,
    reinstall: bool,
    spinner: usize,
}

impl Setup {
    fn new(reinstall: bool) -> Self {
        let dir = common::install_dir();
        Self {
            pick_dir: dir.clone(),
            pick_input: dir.display().to_string(),
            pick_dirs: Vec::new(),
            pick_error: None,
            picking: false,
            dir,
            screen: if !reinstall && common::installed_in(&common::install_dir()) {
                Screen::AlreadyInstalled
            } else {
                Screen::Offer
            },
            steps: STEPS
                .iter()
                .map(|name| (StepState::Waiting, (*name).to_string()))
                .collect(),
            rx: None,
            error: None,
            reinstall,
            spinner: 0,
        }
    }

    fn start(&mut self) {
        self.screen = Screen::Installing;
        self.error = None;
        self.steps = STEPS
            .iter()
            .map(|name| (StepState::Waiting, (*name).to_string()))
            .collect();

        let dir = self.dir.clone();
        let (tx, rx) = channel();
        self.rx = Some(rx);
        std::thread::spawn(move || {
            let sender = tx.clone();
            let mut report = move |event: common::Progress| {
                let _ = sender.send(Msg::Progress(event));
            };
            let result = common::install(&dir, &mut report);
            let _ = tx.send(Msg::Finished(result));
        });
    }

    fn pump(&mut self, ctx: &egui::Context) {
        let Some(rx) = &self.rx else { return };
        let mut finished = false;
        while let Ok(msg) = rx.try_recv() {
            match msg {
                Msg::Progress(common::Progress::Begin { step }) => {
                    if let Some(item) = self.steps.get_mut(step) {
                        item.0 = StepState::Running;
                    }
                }
                Msg::Progress(common::Progress::Ok { step, note }) => {
                    if let Some(item) = self.steps.get_mut(step) {
                        item.0 = StepState::Done;
                        item.1 = format!("{} — {note}", STEPS[step]);
                    }
                }
                Msg::Progress(common::Progress::Fail { step, .. }) => {
                    if let Some(item) = self.steps.get_mut(step) {
                        item.0 = StepState::Failed;
                    }
                }
                Msg::Finished(result) => {
                    finished = true;
                    match result {
                        Ok(_) => self.screen = Screen::Done,
                        Err(error) => {
                            self.error = Some(error);
                            self.screen = Screen::Failed;
                        }
                    }
                }
            }
        }
        if finished {
            self.rx = None;
        }
        if self.screen == Screen::Installing {
            // анимация «…» и опрос фонового потока
            self.spinner = self.spinner.wrapping_add(1);
            ctx.request_repaint_after(Duration::from_millis(120));
        }
    }

    fn close(&self, ctx: &egui::Context) {
        ctx.send_viewport_cmd(egui::ViewportCommand::Close);
    }

    /* ───────────────────────── отрисовка ───────────────────────── */

    fn rule(&self, ui: &mut egui::Ui) {
        let font = FontId::monospace(FONT);
        let width = ui.available_width();
        let char_w = ui
            .painter()
            .layout_no_wrap("=".to_owned(), font.clone(), TEXT)
            .size()
            .x;
        let count = if char_w > 0.0 {
            (width / char_w).floor().max(8.0) as usize
        } else {
            60
        };
        ui.label(mono_color("=".repeat(count), TEXT));
    }

    fn blank(&self, ui: &mut egui::Ui, height: f32) {
        ui.add_space(height);
    }

    fn key_value(&self, ui: &mut egui::Ui, key: &str, value: &str) {
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 0.0;
            ui.label(mono(format!("  {key:<LABEL$}")));
            ui.label(mono_color(value, TEXT));
        });
    }

    fn body_line(&self, ui: &mut egui::Ui, text: &str) {
        ui.label(mono(text));
    }

    fn strong_line(&self, ui: &mut egui::Ui, text: &str) {
        ui.label(mono_color(text, Color32::WHITE).strong());
    }

    /// Кнопка в духе консоли: моноширинная, с рамкой; главная — инверсия.
    fn button(&self, ui: &mut egui::Ui, label: &str, primary: bool, enabled: bool) -> egui::Response {
        let (fill, hover, active, text_color, border) = if primary {
            (INV_BG, Color32::from_rgb(0xff, 0xff, 0xff), Color32::from_rgb(0xd8, 0xd8, 0xdc), INV_FG, INV_BG)
        } else {
            (BTN_BG, BTN_HOVER, BTN_ACTIVE, TEXT, LINE)
        };
        let visuals = &mut ui.style_mut().visuals.widgets;
        visuals.inactive.weak_bg_fill = fill;
        visuals.inactive.bg_stroke = Stroke::new(1.0_f32, border);
        visuals.hovered.weak_bg_fill = hover;
        visuals.hovered.bg_stroke = Stroke::new(1.0_f32, if primary { hover } else { Color32::from_rgb(0x4a, 0x4a, 0x52) });
        visuals.active.weak_bg_fill = active;
        visuals.active.bg_stroke = visuals.hovered.bg_stroke;
        let text = RichText::new(label).font(FontId::monospace(FONT)).color(text_color);
        // одна ширина и высота у всех кнопок — ряд больше не «пляшет»
        let mut button = egui::Button::new(text).min_size(egui::vec2(152.0, 34.0));
        if !enabled {
            button = button.sense(egui::Sense::hover());
        }
        ui.add(button)
    }

    fn steps_block(&self, ui: &mut egui::Ui) {
        for (index, (state, text)) in self.steps.iter().enumerate() {
            let (mark, color) = match state {
                StepState::Waiting => ("·", DIM2),
                StepState::Running => {
                    let frames = ["|", "/", "-", "\\"];
                    let frame = frames[(self.spinner / 2) % frames.len()];
                    (frame, TEXT)
                }
                StepState::Done => ("✓", TEXT),
                StepState::Failed => ("✗", Color32::from_rgb(0xff, 0x8b, 0x7b)),
            };
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 0.0;
                ui.label(mono_color(format!("   {}. {mark} ", index + 1), color));
                ui.label(mono_color(text.clone(), if *state == StepState::Waiting { DIM } else { TEXT }));
            });
        }
    }

    fn path_row(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 8.0;
            ui.label(mono(format!("  {:<LABEL$}", "Куда установится:")));
            ui.label(mono_color(self.dir.display().to_string(), TEXT));
            if self.button(ui, "Выбрать папку", false, true).clicked() {
                self.pick_open();
            }
        });
    }

    /* ───────────── выбор папки установки внутри установщика ───────────── */

    fn pick_open(&mut self) {
        self.picking = true;
        self.pick_error = None;
        // начинаем с текущего пути, а если его ещё нет — с домашней папки
        let start = if self.dir.exists() {
            self.dir.clone()
        } else if let Some(home) = home_dir() {
            home
        } else {
            self.dir.clone()
        };
        self.pick_goto(start);
    }

    fn pick_goto(&mut self, path: PathBuf) {
        self.pick_dir = path;
        self.pick_input = self.pick_dir.display().to_string();
        self.pick_reload();
    }

    fn pick_reload(&mut self) {
        self.pick_dirs.clear();
        self.pick_error = None;
        match std::fs::read_dir(&self.pick_dir) {
            Ok(read) => {
                for entry in read.flatten() {
                    let is_dir = entry.file_type().map(|file| file.is_dir()).unwrap_or(false);
                    if !is_dir {
                        continue;
                    }
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name.starts_with('.') {
                        continue;
                    }
                    self.pick_dirs.push((name, entry.path()));
                }
                self.pick_dirs
                    .sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
            }
            Err(error) => self.pick_error = Some(error.to_string()),
        }
    }

    /// Окно выбора папки: список подпапок, быстрые места и ручной ввод пути.
    fn picker(&mut self, ctx: &egui::Context) {
        if !self.picking {
            return;
        }
        let mut go: Option<PathBuf> = None;
        let mut choose = false;
        let mut cancel = false;
        let places = pick_places();
        let current = self.pick_dir.display().to_string();
        let can_up = self.pick_dir.parent().is_some();

        egui::Window::new("Куда установить OmniSpec")
            .collapsible(false)
            .resizable(false)
            .default_width(700.0)
            .anchor(egui::Align2::CENTER_CENTER, egui::vec2(0.0, 0.0))
            .show(ctx, |ui| {
                ui.label(mono_color("Выбери папку — лаунчер распакуется прямо в неё.", DIM));
                self.blank(ui, 8.0);

                // быстрые места: домашняя папка, рабочий стол, диски
                ui.horizontal_wrapped(|ui| {
                    ui.spacing_mut().item_spacing = egui::vec2(6.0, 6.0);
                    for (label, path) in &places {
                        if small_button(ui, label).clicked() {
                            go = Some(path.clone());
                        }
                    }
                });
                self.blank(ui, 8.0);

                // текущая папка и переход на уровень выше
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 6.0;
                    if small_button(ui, "↑ вверх").clicked() && can_up {
                        if let Some(parent) = self.pick_dir.parent() {
                            go = Some(parent.to_path_buf());
                        }
                    }
                    ui.label(mono_color(current.clone(), TEXT));
                });
                self.blank(ui, 6.0);

                // список подпапок
                egui::Frame::NONE
                    .fill(INPUT_BG)
                    .stroke(Stroke::new(1.0_f32, LINE))
                    .inner_margin(egui::Margin::same(6))
                    .show(ui, |ui| {
                        egui::ScrollArea::vertical()
                            .max_height(240.0)
                            .show(ui, |ui| {
                                if let Some(error) = &self.pick_error {
                                    ui.label(mono_color(error.clone(), Color32::from_rgb(0xff, 0x8b, 0x7b)));
                                } else if self.pick_dirs.is_empty() {
                                    ui.label(mono_color("  подпапок нет", DIM2));
                                }
                                for (name, path) in &self.pick_dirs {
                                    let label = format!("  [ ] {name}");
                                    if ui
                                        .add(
                                            egui::Button::new(mono_color(label, TEXT))
                                                .fill(Color32::TRANSPARENT)
                                                .stroke(Stroke::new(0.0_f32, Color32::TRANSPARENT))
                                                .min_size(egui::vec2(ui.available_width(), 24.0)),
                                        )
                                        .clicked()
                                    {
                                        go = Some(path.clone());
                                    }
                                }
                            });
                    });
                self.blank(ui, 8.0);

                // ручной ввод пути
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 6.0;
                    let input = ui.add(
                        egui::TextEdit::singleline(&mut self.pick_input)
                            .font(FontId::monospace(FONT))
                            .desired_width(430.0)
                            .text_color(TEXT),
                    );
                    let entered = input.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
                    if small_button(ui, "Перейти").clicked() || entered {
                        go = Some(common::expand_path(self.pick_input.trim()));
                    }
                });

                self.blank(ui, 10.0);
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 8.0;
                    if self.button(ui, "Выбрать эту папку", true, true).clicked() {
                        choose = true;
                    }
                    if self.button(ui, "Отмена", false, true).clicked() {
                        cancel = true;
                    }
                });
            });

        if let Some(path) = go {
            self.pick_goto(path);
        }
        if choose {
            self.dir = self.pick_dir.clone();
            self.pick_input = self.dir.display().to_string();
            self.picking = false;
        }
        if cancel {
            self.picking = false;
        }
        if ctx.input(|input| input.key_pressed(egui::Key::Escape)) {
            self.picking = false;
        }
    }

    fn header(&self, ui: &mut egui::Ui) {
        self.rule(ui);
        ui.vertical_centered(|ui| {
            ui.label(
                RichText::new("O m n i S p e c")
                    .font(FontId::monospace(FONT + 2.0))
                    .color(Color32::WHITE)
                    .strong(),
            );
            ui.label(mono_color("лаунчер Minecraft · установка", DIM));
        });
        self.rule(ui);
    }

    fn offer(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        self.blank(ui, 10.0);
        self.key_value(ui, "Версия:", common::version());
        self.path_row(ui);
        self.key_value(ui, "Внутри:", &common::inside_text());
        self.blank(ui, 12.0);
        self.strong_line(ui, "  Что будет сделано:");
        self.body_line(ui, "    1. лаунчер распакуется в папку пользователя (права админа не нужны)");
        self.body_line(ui, "    2. на рабочем столе и в меню «Пуск» появятся ярлыки");
        self.body_line(ui, "    3. при первом запуске лаунчер сам скачает Java и файлы игры");
        if self.dir.exists() && self.dir.join(APP_EXE).exists() {
            self.blank(ui, 8.0);
            self.strong_line(ui, "  В этой папке уже есть лаунчер: файл обновится, а сборки,");
            self.strong_line(ui, "  миры и настройки останутся на месте.");
            self.blank(ui, 8.0);
        }
        self.body_line(ui, "    4. лаунчер запустится");
        self.body_line(ui, "    5. обновляться он будет сам — из GitHub Releases");

        self.blank(ui, 14.0);
        self.rule(ui);
        self.blank(ui, 10.0);

        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 10.0;
            let install = self.button(ui, "Установить", true, !self.picking);
            if install.clicked() {
                self.start();
            }
            if self.button(ui, "Выбрать папку", false, true).clicked() {
                self.pick_open();
            }
            if self.button(ui, "Отмена", false, true).clicked() {
                self.close(ctx);
            }
            ui.add_space(6.0);
            ui.label(mono_color("Enter — установить,  Esc — отмена", DIM2));
        });

        if !self.picking && ctx.input(|input| input.key_pressed(egui::Key::Enter)) {
            self.start();
        }
        if ctx.input(|input| input.key_pressed(egui::Key::Escape)) {
            self.close(ctx);
        }
    }

    fn installing(&mut self, ui: &mut egui::Ui) {
        self.blank(ui, 10.0);
        self.key_value(ui, "Версия:", common::version());
        self.key_value(ui, "Куда установится:", &self.dir.display().to_string());
        self.key_value(ui, "Внутри:", &common::inside_text());
        self.blank(ui, 14.0);
        self.strong_line(ui, "  Устанавливаю:");
        self.blank(ui, 4.0);
        self.steps_block(ui);
        self.blank(ui, 14.0);
        self.rule(ui);
        self.blank(ui, 10.0);
        ui.horizontal(|ui| {
            ui.label(mono_color("  Идёт установка — подожди пару секунд.", DIM));
        });
    }

    fn done(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        self.blank(ui, 10.0);
        self.strong_line(ui, "  Установлено.");
        self.blank(ui, 8.0);
        self.key_value(ui, "Папка:", &self.dir.display().to_string());
        self.blank(ui, 10.0);
        self.steps_block(ui);
        self.blank(ui, 14.0);
        self.body_line(ui, "  Файл-установщик можно удалить — лаунчер уже на месте и");
        self.body_line(ui, "  запускается ярлыком. Если запустить установщик снова, он");
        self.body_line(ui, "  просто откроет установленный лаунчер.");
        self.blank(ui, 14.0);
        self.rule(ui);
        self.blank(ui, 10.0);
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 10.0;
            if self.button(ui, "Запустить лаунчер", true, true).clicked() {
                common::launch(&self.dir.join(APP_EXE));
                self.close(ctx);
            }
            if self.button(ui, "Открыть папку", false, true).clicked() {
                common::open_folder(&self.dir);
            }
            if self.button(ui, "Закрыть", false, true).clicked() {
                self.close(ctx);
            }
        });
    }

    fn already(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        self.blank(ui, 10.0);
        self.strong_line(ui, &format!("  {APP_NAME} уже установлен."));
        self.blank(ui, 8.0);
        self.key_value(ui, "Папка:", &self.dir.display().to_string());
        self.blank(ui, 10.0);
        self.body_line(ui, "  Обновления лаунчер проверяет сам при запуске. Кнопка");
        self.body_line(ui, "  «Переустановить» заменит файлы, а сборки и миры останутся.");
        self.blank(ui, 14.0);
        self.rule(ui);
        self.blank(ui, 10.0);
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 10.0;
            if self.button(ui, "Запустить лаунчер", true, true).clicked() {
                common::launch(&self.dir.join(APP_EXE));
                self.close(ctx);
            }
            if self.button(ui, "Переустановить", false, true).clicked() {
                self.reinstall = true;
                self.screen = Screen::Offer;
            }
            if self.button(ui, "Изменить путь", false, true).clicked() {
                self.reinstall = true;
                self.screen = Screen::Offer;
                self.pick_open();
            }
            if self.button(ui, "Закрыть", false, true).clicked() {
                self.close(ctx);
            }
        });
        if !self.picking && ctx.input(|input| input.key_pressed(egui::Key::Escape)) {
            self.close(ctx);
        }
    }

    fn failed(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        self.blank(ui, 10.0);
        self.strong_line(ui, "  Не получилось установить.");
        self.blank(ui, 8.0);
        if let Some(error) = &self.error {
            self.body_line(ui, &format!("  {error}"));
        }
        self.blank(ui, 8.0);
        self.body_line(ui, "  Можно скачать OmniSpec.exe вручную — он работает и без установки.");
        self.blank(ui, 14.0);
        self.rule(ui);
        self.blank(ui, 10.0);
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 10.0;
            if self.button(ui, "Повторить", true, true).clicked() {
                self.start();
            }
            if self.button(ui, "Открыть папку", false, true).clicked() {
                common::open_folder(&self.dir);
            }
            if self.button(ui, "Закрыть", false, true).clicked() {
                self.close(ctx);
            }
        });
    }
}

impl eframe::App for Setup {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.pump(ctx);

        egui::CentralPanel::default()
            .frame(egui::Frame::NONE.fill(BG).inner_margin(egui::Margin::same(16)))
            .show(ctx, |ui| {
                self.header(ui);
                egui::ScrollArea::vertical().show(ui, |ui| match self.screen {
                    Screen::Offer => self.offer(ui, ctx),
                    Screen::Installing => self.installing(ui),
                    Screen::Done => self.done(ui, ctx),
                    Screen::AlreadyInstalled => self.already(ui, ctx),
                    Screen::Failed => self.failed(ui, ctx),
                });
            });

        self.picker(ctx);
    }
}

/* ───────────────────────── запуск окна ───────────────────────── */

fn window_icon() -> Option<egui::IconData> {
    let image = image::load_from_memory(common::ICON_PNG).ok()?.to_rgba8();
    let (width, height) = image.dimensions();
    Some(egui::IconData {
        rgba: image.into_raw(),
        width,
        height,
    })
}

pub fn run(reinstall: bool) -> eframe::Result {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title(format!("{APP_NAME} — установка"))
            .with_inner_size([880.0, 600.0])
            .with_min_inner_size([720.0, 520.0])
            .with_icon(window_icon().unwrap_or(egui::IconData {
                rgba: vec![0; 4],
                width: 1,
                height: 1,
            })),
        centered: true,
        ..Default::default()
    };

    eframe::run_native(
        &format!("{APP_NAME} — установка"),
        options,
        Box::new(move |cc| {
            install_style(&cc.egui_ctx);
            Ok(Box::new(Setup::new(reinstall)))
        }),
    )
}

/// Тёмный стиль в духе консоли OmniPanel: чёрный фон, моноширинный шрифт.
fn install_style(ctx: &egui::Context) {
    let mut fonts = egui::FontDefinitions::default();
    let mono = egui::FontData::from_static(include_bytes!("../fonts/DejaVuSansMono.ttf"));
    fonts
        .font_data
        .insert("omnispec-mono".to_owned(), mono.into());
    for family in [egui::FontFamily::Monospace, egui::FontFamily::Proportional] {
        fonts
            .families
            .entry(family)
            .or_default()
            .insert(0, "omnispec-mono".to_owned());
    }
    ctx.set_fonts(fonts);

    let mut style = (*ctx.style()).clone();
    style.visuals = egui::Visuals::dark();
    style.visuals.panel_fill = BG;
    style.visuals.window_fill = BG;
    style.visuals.extreme_bg_color = INPUT_BG;
    style.visuals.override_text_color = Some(TEXT);
    style.visuals.widgets.noninteractive.bg_stroke = Stroke::new(0.0_f32, Color32::TRANSPARENT);
    style.visuals.selection.bg_fill = Color32::from_rgb(0x2a, 0x2a, 0x30);
    style.visuals.selection.stroke = Stroke::new(1.0_f32, TEXT);
    style.text_styles = [
        (egui::TextStyle::Body, FontId::monospace(FONT)),
        (egui::TextStyle::Monospace, FontId::monospace(FONT)),
        (egui::TextStyle::Button, FontId::monospace(FONT)),
        (egui::TextStyle::Small, FontId::monospace(FONT - 1.0)),
        (egui::TextStyle::Heading, FontId::monospace(FONT + 2.0)),
    ]
    .into();
    style.spacing.item_spacing = egui::vec2(0.0, 6.0);
    style.spacing.button_padding = egui::vec2(14.0, 7.0);
    ctx.set_style(style);
}
