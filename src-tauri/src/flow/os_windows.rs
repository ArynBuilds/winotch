// Flow dictation on Windows: the key, through a low-level keyboard hook (it
// only watches, it never swallows a key); the paste, through SendInput; and
// the app in front, from the foreground window's program.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{
    GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
    VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, EnumWindows, GetForegroundWindow, GetMessageW, GetWindowTextLengthW,
    GetWindowThreadProcessId, IsWindowVisible, PostThreadMessageW, SetWindowsHookExW, TranslateMessage,
    UnhookWindowsHookEx, KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_QUIT,
    WM_SYSKEYDOWN, WM_SYSKEYUP,
};

use super::logic::FlowKey;
use super::KeyEvent;

const VK_ESCAPE: u32 = 0x1B;
const VK_V: u16 = 0x56;
const VK_CONTROL: u16 = 0x11;
const VK_SHIFT_KEY: u16 = 0x10;
const VK_LSHIFT: u32 = 0xA0;
const VK_RSHIFT: u32 = 0xA1;
const VK_LCONTROL: u32 = 0xA2;
const VK_RCONTROL: u32 = 0xA3;
const VK_LMENU: u32 = 0xA4;
const VK_RMENU: u32 = 0xA5;
const VK_LWIN: u32 = 0x5B;
const VK_RWIN: u32 = 0x5C;

/// Modifier keys never count as "another key": AltGr even sends a fake left
/// Ctrl with every right Alt.
fn is_modifier(vk: u32) -> bool {
    matches!(vk, 0x10 | 0x11 | 0x12 | VK_LSHIFT..=VK_RMENU | VK_LWIN | VK_RWIN | 0x14)
}

static SINK: Mutex<Option<Sender<(KeyEvent, Instant)>>> = Mutex::new(None);
static KEY: AtomicU8 = AtomicU8::new(0);
/// For Ctrl + Win: which of the two is down (bit 0 Ctrl, bit 1 Win).
static COMBO: AtomicU8 = AtomicU8::new(0);
static HELD: AtomicU8 = AtomicU8::new(0);
/// Right Shift is down: with the dictation key held it asks Claude Code
/// instead of typing (KeyEvent::Ask). Left Shift does not (the user's call:
/// Right Ctrl and Right Shift, one hand).
static SHIFTS: AtomicU8 = AtomicU8::new(0);
/// What the hook itself heard lately (key, down, when): a key winotch's own
/// window also passes on (`forward_key`) is not counted twice.
static HEARD: Mutex<Vec<(u32, bool, Instant)>> = Mutex::new(Vec::new());
/// A key the hook heard this recently is the one the window passes on.
const HEARD_WITHIN: Duration = Duration::from_millis(400);

fn key_code(key: FlowKey) -> u8 {
    match key {
        FlowKey::RightCtrl => 0,
        FlowKey::RightAlt => 1,
        FlowKey::RightShift => 2,
        FlowKey::LeftCtrlSuper => 3,
    }
}

fn send(event: KeyEvent) {
    if let Some(tx) = SINK.lock().unwrap().as_ref() {
        let _ = tx.send((event, Instant::now()));
    }
}

unsafe extern "system" fn hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        // Our own Ctrl+V, and other programs' synthetic keys, are not the user's.
        if info.flags.0 & LLKHF_INJECTED.0 == 0 {
            let down = matches!(wparam.0 as u32, WM_KEYDOWN | WM_SYSKEYDOWN);
            let up = matches!(wparam.0 as u32, WM_KEYUP | WM_SYSKEYUP);
            if down || up {
                let mut heard = HEARD.lock().unwrap();
                heard.retain(|&(_, _, at)| at.elapsed() < HEARD_WITHIN);
                heard.push((info.vkCode, down, Instant::now()));
            }
            on_key(info.vkCode, down, up);
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

fn on_key(vk: u32, down: bool, up: bool) {
    let key = KEY.load(Ordering::Relaxed);
    let ours = match key {
        0 => vk == VK_RCONTROL,
        1 => vk == VK_RMENU,
        2 => vk == VK_RSHIFT,
        _ => false,
    };
    if key == 3 && matches!(vk, VK_LCONTROL | VK_LWIN) {
        let bit = if vk == VK_LCONTROL { 1 } else { 2 };
        let before = COMBO.load(Ordering::Relaxed);
        let after = if down { before | bit } else if up { before & !bit } else { before };
        COMBO.store(after, Ordering::Relaxed);
        if before != 3 && after == 3 {
            send(KeyEvent::Down);
        } else if before == 3 && after != 3 {
            send(KeyEvent::Up);
        } else if after == 3 && down {
            send(KeyEvent::Down); // repeat
        }
        return;
    }
    // winotch: Right Shift while the dictation key is held (or already down
    // when it goes down): what is said is asked of Claude Code, not typed. A
    // modifier, never "another key" that cancels. Not with Right Shift as the key.
    if vk == VK_RSHIFT && key != 2 {
        let before = SHIFTS.load(Ordering::Relaxed);
        let after = if down { 1 } else if up { 0 } else { before };
        SHIFTS.store(after, Ordering::Relaxed);
        if down && before == 0 && HELD.load(Ordering::Relaxed) == 1 {
            send(KeyEvent::Ask);
        }
        return;
    }
    if ours {
        if down {
            let was = HELD.swap(1, Ordering::Relaxed);
            send(KeyEvent::Down);
            if was == 0 && SHIFTS.load(Ordering::Relaxed) != 0 && key != 2 {
                send(KeyEvent::Ask);
            }
        } else if up {
            HELD.store(0, Ordering::Relaxed);
            send(KeyEvent::Up);
        }
        return;
    }
    if !down {
        return;
    }
    if vk == VK_ESCAPE {
        send(KeyEvent::Escape);
    } else if !is_modifier(vk) {
        send(KeyEvent::Other);
    }
}

/// A key pressed or released in one of winotch's own fields (the chat, Today).
/// While its webview has the keyboard, the hook never hears the dictation key:
/// the webview's browser process sits ahead of it and keeps the modifier keys
/// to itself, letters getting through. So the island passes its keys on, and
/// any the hook did hear are dropped here. `code` is the browser's
/// KeyboardEvent.code, telling left from right; `vk` its keyCode, which on
/// Windows is the virtual key for every other key.
pub fn forward_key(code: &str, vk: u32, down: bool) {
    let vk = match code {
        "ControlRight" => VK_RCONTROL,
        "ControlLeft" => VK_LCONTROL,
        "AltRight" => VK_RMENU,
        "AltLeft" => VK_LMENU,
        "ShiftRight" => VK_RSHIFT,
        "ShiftLeft" => VK_LSHIFT,
        "MetaLeft" => VK_LWIN,
        "MetaRight" => VK_RWIN,
        "Escape" => VK_ESCAPE,
        _ => vk,
    };
    let heard = HEARD
        .lock()
        .unwrap()
        .iter()
        .any(|&(k, d, at)| k == vk && d == down && at.elapsed() < HEARD_WITHIN);
    if !heard {
        on_key(vk, down, !down);
    }
}

/// The hook's thread; it ends when dropped.
pub struct KeyListener {
    thread_id: u32,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for KeyListener {
    fn drop(&mut self) {
        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        *SINK.lock().unwrap() = None;
    }
}

pub fn listen(key: FlowKey, tx: Sender<(KeyEvent, Instant)>) -> Result<KeyListener, String> {
    KEY.store(key_code(key), Ordering::Relaxed);
    COMBO.store(0, Ordering::Relaxed);
    *SINK.lock().unwrap() = Some(tx);
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<u32, String>>();
    let thread = std::thread::Builder::new()
        .name("winotch-flow-keys".into())
        .spawn(move || unsafe {
            let module = GetModuleHandleW(None).ok();
            let handle = match SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook), module.map(Into::into), 0) {
                Ok(h) => h,
                Err(err) => {
                    let _ = ready_tx.send(Err(err.to_string()));
                    return;
                }
            };
            let _ = ready_tx.send(Ok(GetCurrentThreadId()));
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            let _ = UnhookWindowsHookEx(handle);
        })
        .map_err(|e| e.to_string())?;
    match ready_rx.recv_timeout(Duration::from_secs(3)) {
        Ok(Ok(thread_id)) => Ok(KeyListener { thread_id, thread: Some(thread) }),
        Ok(Err(err)) => Err(err),
        Err(_) => Err("the keyboard hook did not start".into()),
    }
}

/// Waits (up to a second) until the dictation key is up, so the paste is a
/// plain Ctrl+V and not Ctrl+Alt+V or Ctrl+Shift+V.
pub fn wait_key_released(key: FlowKey) {
    let vk = match key {
        FlowKey::RightCtrl => VK_RCONTROL,
        FlowKey::RightAlt => VK_RMENU,
        FlowKey::RightShift => VK_RSHIFT,
        FlowKey::LeftCtrlSuper => VK_LWIN,
    } as i32;
    let until = Instant::now() + Duration::from_secs(1);
    while Instant::now() < until {
        let state = unsafe { GetAsyncKeyState(vk) } as u16;
        if state & 0x8000 == 0 {
            return;
        }
        std::thread::sleep(Duration::from_millis(15));
    }
}

fn key_input(vk: u16, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: 0,
                dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// Ctrl+V in the app in front. Ctrl+Shift+V for a terminal that wants it.
pub fn send_paste(shift: bool) -> Result<(), String> {
    let mut inputs = vec![key_input(VK_CONTROL, false)];
    if shift {
        inputs.push(key_input(VK_SHIFT_KEY, false));
    }
    inputs.push(key_input(VK_V, false));
    inputs.push(key_input(VK_V, true));
    if shift {
        inputs.push(key_input(VK_SHIFT_KEY, true));
    }
    inputs.push(key_input(VK_CONTROL, true));
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize == inputs.len() {
        Ok(())
    } else {
        Err("Windows refused the keystrokes".into())
    }
}

/// A window's program: "outlook", "Outlook".
fn program_of(hwnd: HWND) -> Option<(String, String)> {
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32));
        if pid == 0 || pid == std::process::id() {
            return None;
        }
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(process);
        if !ok {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        let stem = std::path::Path::new(&path).file_stem()?.to_string_lossy().to_string();
        Some((stem.to_lowercase(), super::display_name(&stem)))
    }
}

/// The app in front: (id, name), None for winotch itself or the desktop.
pub fn foreground_app() -> Option<(String, String)> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return None;
    }
    program_of(hwnd)
}

/// Apps with a visible window, for "Add an app" in Styles.
pub fn running_apps() -> Vec<(String, String)> {
    unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
        let list = &mut *(lparam.0 as *mut Vec<(String, String)>);
        if IsWindowVisible(hwnd).as_bool() && GetWindowTextLengthW(hwnd) > 0 {
            if let Some(app) = program_of(hwnd) {
                if !list.iter().any(|(id, _)| *id == app.0) && !super::is_shell(&app.0) {
                    list.push(app);
                }
            }
        }
        windows::core::BOOL(1)
    }
    let mut list: Vec<(String, String)> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(each), LPARAM(&mut list as *mut _ as isize));
    }
    list
}

/// Whether the platform can listen for the key at all.
pub fn keys_supported() -> Result<(), &'static str> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The tests share the hook's statics: one at a time.
    static SERIAL: Mutex<()> = Mutex::new(());

    fn sink() -> std::sync::mpsc::Receiver<(KeyEvent, Instant)> {
        let (tx, rx) = std::sync::mpsc::channel();
        *SINK.lock().unwrap() = Some(tx);
        KEY.store(key_code(FlowKey::RightCtrl), Ordering::Relaxed);
        HEARD.lock().unwrap().clear();
        HELD.store(0, Ordering::Relaxed);
        SHIFTS.store(0, Ordering::Relaxed);
        rx
    }

    #[test]
    fn shift_with_the_key_held_asks_once_and_never_cancels() {
        let _one = SERIAL.lock().unwrap();
        let rx = sink();
        on_key(VK_RCONTROL, true, false);
        on_key(VK_RSHIFT, true, false);
        on_key(VK_RSHIFT, true, false); // its repeat
        on_key(VK_RCONTROL, true, false); // the key's repeat
        on_key(VK_RSHIFT, false, true);
        on_key(VK_RCONTROL, false, true);
        assert_eq!(events(&rx), vec![KeyEvent::Down, KeyEvent::Ask, KeyEvent::Down, KeyEvent::Up]);
    }

    #[test]
    fn shift_already_down_when_the_key_goes_down_asks_too() {
        let _one = SERIAL.lock().unwrap();
        let rx = sink();
        on_key(VK_RSHIFT, true, false);
        on_key(VK_RCONTROL, true, false);
        on_key(VK_RCONTROL, false, true);
        on_key(VK_RSHIFT, false, true);
        assert_eq!(events(&rx), vec![KeyEvent::Down, KeyEvent::Ask, KeyEvent::Up]);
        // Left Shift is only a modifier: it neither asks nor cancels.
        on_key(VK_RCONTROL, true, false);
        on_key(VK_LSHIFT, true, false);
        on_key(VK_LSHIFT, false, true);
        on_key(VK_RCONTROL, false, true);
        assert_eq!(events(&rx), vec![KeyEvent::Down, KeyEvent::Up]);
        // Shift alone, the key not held: nothing.
        on_key(VK_RSHIFT, true, false);
        on_key(VK_RSHIFT, false, true);
        assert_eq!(events(&rx), vec![]);
    }

    fn events(rx: &std::sync::mpsc::Receiver<(KeyEvent, Instant)>) -> Vec<KeyEvent> {
        rx.try_iter().map(|(e, _)| e).collect()
    }

    #[test]
    fn a_key_the_hook_missed_reaches_dictation_from_the_window() {
        let _one = SERIAL.lock().unwrap();
        let rx = sink();
        forward_key("ControlRight", 17, true);
        forward_key("KeyA", 0x41, true);
        forward_key("ControlRight", 17, false);
        forward_key("Escape", 27, true);
        assert_eq!(events(&rx), vec![KeyEvent::Down, KeyEvent::Other, KeyEvent::Up, KeyEvent::Escape]);
        // The left Ctrl is not the key, and a modifier is never "another key".
        forward_key("ControlLeft", 17, true);
        assert_eq!(events(&rx), vec![]);
    }

    #[test]
    fn a_key_the_hook_heard_is_not_counted_twice() {
        let _one = SERIAL.lock().unwrap();
        let rx = sink();
        HEARD.lock().unwrap().push((VK_RCONTROL, true, Instant::now()));
        forward_key("ControlRight", 17, true);
        assert_eq!(events(&rx), vec![]);
        // Heard going down, not coming up: the release still counts.
        forward_key("ControlRight", 17, false);
        assert_eq!(events(&rx), vec![KeyEvent::Up]);
    }
}
