// Disposable replacement for wallpaper64.exe in the isolated Windows GUI test.
// It records the exact argument vector; it does NOT emulate Wallpaper Engine.
#![windows_subsystem = "windows"]
fn main() {
    let output = std::env::var_os("OMNISPEC_TEST_WE_LOG").expect("probe log path");
    let args: Vec<_> = std::env::args().skip(1).collect();
    std::fs::write(output, args.join("\n")).expect("write probe arguments");
}
