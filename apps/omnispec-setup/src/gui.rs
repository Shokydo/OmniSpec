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
    editing_path: bool,
    path_input: String,
    screen: Screen,
    steps: Vec<(StepState, String)>,
    rx: Option<Receiver<Msg>>,
    error: Option<String>,
    reinstall: bool,
    focus_input: bool,
    spinner: usize,
}

impl Setup {
    fn new(reinstall: bool) -> Self {
        let dir = common::install_dir();
        Self {
            path_input: dir.display().to_string(),
            dir,
            editing_path: false,
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
            focus_input: false,
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
        let mut button = egui::Button::new(text).min_size(egui::vec2(0.0, 32.0));
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
        if self.editing_path {
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 8.0;
                ui.label(mono(format!("  {:<LABEL$}", "Куда установится:")));
                let input = ui.add(
                    egui::TextEdit::singleline(&mut self.path_input)
                        .font(FontId::monospace(FONT))
                        .desired_width(330.0)
                        .text_color(TEXT),
                );
                if self.focus_input {
                    input.request_focus();
                    self.focus_input = false;
                }
                if self.button(ui, "готово", true, true).clicked() {
                    self.apply_path();
                }
                if self.button(ui, "отмена", false, true).clicked() {
                    self.editing_path = false;
                    self.path_input = self.dir.display().to_string();
                }
            });
        } else {
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 8.0;
                ui.label(mono(format!("  {:<LABEL$}", "Куда установится:")));
                ui.label(mono_color(self.dir.display().to_string(), TEXT));
                if self.button(ui, "изменить путь", false, true).clicked() {
                    self.editing_path = true;
                    self.focus_input = true;
                }
            });
        }
    }

    fn apply_path(&mut self) {
        let raw = self.path_input.trim();
        if raw.is_empty() {
            self.path_input = self.dir.display().to_string();
            self.editing_path = false;
            return;
        }
        self.dir = common::expand_path(raw);
        self.path_input = self.dir.display().to_string();
        self.editing_path = false;
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
            let install = self.button(ui, "Установить", true, !self.editing_path);
            if install.clicked() {
                self.start();
            }
            if self.button(ui, "Изменить путь", false, true).clicked() {
                self.editing_path = true;
                self.focus_input = true;
            }
            if self.button(ui, "Отмена", false, true).clicked() {
                self.close(ctx);
            }
            ui.add_space(6.0);
            ui.label(mono_color("Enter — установить,  Esc — отмена", DIM2));
        });

        if !self.editing_path && ctx.input(|input| input.key_pressed(egui::Key::Enter)) {
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
                self.editing_path = true;
                self.focus_input = true;
            }
            if self.button(ui, "Закрыть", false, true).clicked() {
                self.close(ctx);
            }
        });
        if ctx.input(|input| input.key_pressed(egui::Key::Escape)) {
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
