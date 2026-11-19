//! Физическая ОЗУ, доступная системе: не объём диска, виртуальной памяти
//! или текущего свободного остатка. Используется только для границ ползунков.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct SystemMemory {
    pub total_mb: u64,
}

pub fn read() -> Option<SystemMemory> {
    let total_mb = total_bytes()? / (1024 * 1024);
    (total_mb > 0).then_some(SystemMemory { total_mb })
}

#[cfg(target_os = "linux")]
fn total_bytes() -> Option<u64> {
    parse_meminfo(&std::fs::read_to_string("/proc/meminfo").ok()?)
}

#[cfg(any(target_os = "linux", test))]
fn parse_meminfo(text: &str) -> Option<u64> {
    let value = text.lines().find_map(|line| line.strip_prefix("MemTotal:"))?;
    let mut parts = value.split_whitespace();
    let kib = parts.next()?.parse::<u64>().ok()?;
    if parts.next()? != "kB" || kib == 0 { return None; }
    kib.checked_mul(1024)
}

#[cfg(windows)]
fn total_bytes() -> Option<u64> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

    // Win32 заполняет структуру только если заранее указан её точный размер.
    let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    let ok = unsafe { GlobalMemoryStatusEx(&mut status) };
    (ok != 0 && status.ullTotalPhys > 0).then_some(status.ullTotalPhys)
}

#[cfg(not(any(windows, target_os = "linux")))]
fn total_bytes() -> Option<u64> { None }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linux_meminfo_is_parsed_in_kib_not_bytes_or_free_memory() {
        assert_eq!(parse_meminfo("MemFree: 123 kB\nMemTotal: 16384000 kB\n"), Some(16384000 * 1024));
        assert_eq!(parse_meminfo("MemTotal: 0 kB\n"), None);
        assert_eq!(parse_meminfo("MemTotal: 4 MB\n"), None);
        assert_eq!(parse_meminfo("MemTotal: abc kB\n"), None);
        assert_eq!(parse_meminfo("MemFree: 1024 kB\n"), None);
        assert_eq!(parse_meminfo("MemTotal: 18446744073709551615 kB\n"), None);
    }

    #[test]
    #[cfg(any(windows, target_os = "linux"))]
    fn current_machine_reports_a_positive_total() {
        assert!(read().is_some_and(|memory| memory.total_mb > 0));
    }
}
