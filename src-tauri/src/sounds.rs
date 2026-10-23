// Your own sounds: a file named like one of the app's sounds in the sounds folder
// replaces it (finish.wav, approval.mp3, greet.m4a…), as on the Mac
// (SoundEngine.customFolder). The folder is platform::config_dir()/sounds:
// ~/.config/winotch/sounds on Linux, %APPDATA%\winotch\sounds on Windows.
//
// The page decodes the bytes itself; a file it can't decode falls back to the
// built-in sound there (src/core/sound.ts).

use crate::platform;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

/// Formats a webview can usually decode, looked for in this order.
const EXTENSIONS: [&str; 10] = ["wav", "mp3", "ogg", "oga", "m4a", "aac", "flac", "aiff", "aif", "caf"];
/// A sound effect, not an album: anything bigger is left alone.
const MAX_BYTES: u64 = 8 * 1024 * 1024;

pub fn folder() -> PathBuf {
    platform::config_dir().join("sounds")
}

/// A sound name is a bare lowercase word ("finish"): nothing that could leave the folder.
fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 32 && name.bytes().all(|b| b.is_ascii_lowercase())
}

/// The user's file for `name` in `dir`, if there is a usable one.
fn custom_file(dir: &Path, name: &str) -> Option<PathBuf> {
    if !valid_name(name) {
        return None;
    }
    EXTENSIONS.iter().map(|ext| dir.join(format!("{name}.{ext}"))).find(|p| {
        std::fs::metadata(p).map(|m| m.is_file() && m.len() > 0 && m.len() <= MAX_BYTES).unwrap_or(false)
    })
}

/// Which of `names` have a file of the user's own.
#[tauri::command]
pub fn custom_sounds(names: Vec<String>) -> Vec<String> {
    let dir = folder();
    names.into_iter().filter(|n| custom_file(&dir, n).is_some()).collect()
}

/// The bytes of the user's file for `name`, sent as they are.
#[tauri::command]
pub fn custom_sound(name: String) -> Result<tauri::ipc::Response, String> {
    let path = custom_file(&folder(), &name).ok_or_else(|| format!("no custom sound for {name}"))?;
    std::fs::read(&path).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

/// Settings → Open sounds folder: creates it if needed and shows it.
#[tauri::command]
pub fn reveal_sounds_folder() {
    let dir = folder();
    let _ = std::fs::create_dir_all(&dir);
    platform::reveal_folder(&dir.to_string_lossy());
}

/// Settings → Reload sounds: the island reads the folder again.
#[tauri::command]
pub fn reload_sounds(app: AppHandle) {
    let _ = app.emit("sounds-changed", ());
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch path of the test's own in the temp folder, removed when the
    /// test ends, passed or failed: they were left behind by the hundred.
    struct Scratch(PathBuf);

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = if self.0.is_dir() { std::fs::remove_dir_all(&self.0) } else { std::fs::remove_file(&self.0) };
        }
    }

    impl std::ops::Deref for Scratch {
        type Target = Path;
        fn deref(&self) -> &Path {
            &self.0
        }
    }

    impl AsRef<Path> for Scratch {
        fn as_ref(&self) -> &Path {
            &self.0
        }
    }

    fn scratch(tag: &str) -> Scratch {
        let dir = std::env::temp_dir().join(format!("winotch-sounds-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }

    #[test]
    fn a_file_named_like_a_sound_replaces_it_in_the_first_format_found() {
        let dir = scratch("pick");
        std::fs::write(dir.join("finish.mp3"), b"mp3").unwrap();
        std::fs::write(dir.join("finish.wav"), b"wav").unwrap();
        assert_eq!(custom_file(&dir, "finish"), Some(dir.join("finish.wav")));
        std::fs::write(dir.join("greet.m4a"), b"m4a").unwrap();
        assert_eq!(custom_file(&dir, "greet"), Some(dir.join("greet.m4a")));
        assert_eq!(custom_file(&dir, "approval"), None);
    }

    #[test]
    fn nothing_outside_the_folder_or_unusable_is_read() {
        let dir = scratch("guard");
        std::fs::write(dir.join("empty.wav"), b"").unwrap();
        std::fs::create_dir_all(dir.join("folder.wav")).unwrap();
        std::fs::write(dir.join("notes.txt"), b"x").unwrap();
        assert_eq!(custom_file(&dir, "empty"), None);
        assert_eq!(custom_file(&dir, "folder"), None);
        assert_eq!(custom_file(&dir, "notes"), None);
        for bad in ["../finish", "Finish", "fin ish", "", "a/b", "finish.wav"] {
            assert!(!valid_name(bad), "{bad}");
        }
    }
}
