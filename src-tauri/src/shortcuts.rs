// Accelerator parsing, ported from electron/shortcut-hold.cjs shortcutKeyGroups.
// Accelerator strings keep the Electron format ("Alt+Shift+S") because they are
// persisted in the store and recorded by src/shortcut-utils.js in the renderer.

pub const MOD_ALT: u32 = 0x0001;
pub const MOD_CONTROL: u32 = 0x0002;
pub const MOD_SHIFT: u32 = 0x0004;
pub const MOD_WIN: u32 = 0x0008;
pub const MOD_NOREPEAT: u32 = 0x4000;

const NAMED: &[(&str, &[i32])] = &[
    // Modifiers map to both left and right physical keys, like the JS table.
    ("alt", &[18]),
    ("option", &[18]),
    ("control", &[17]),
    ("ctrl", &[17]),
    ("commandorcontrol", &[17]),
    ("cmdorctrl", &[17]),
    ("shift", &[16]),
    ("super", &[91, 92]),
    ("meta", &[91, 92]),
    ("command", &[91, 92]),
    ("cmd", &[91, 92]),
    ("space", &[32]),
    ("tab", &[9]),
    ("enter", &[13]),
    ("return", &[13]),
    ("escape", &[27]),
    ("esc", &[27]),
    ("backspace", &[8]),
    ("delete", &[46]),
    ("insert", &[45]),
    ("home", &[36]),
    ("end", &[35]),
    ("pageup", &[33]),
    ("pagedown", &[34]),
    ("up", &[38]),
    ("down", &[40]),
    ("left", &[37]),
    ("right", &[39]),
    ("plus", &[187]),
    ("minus", &[189]),
    ("=", &[187]),
    ("-", &[189]),
    (",", &[188]),
    (".", &[190]),
    ("/", &[191]),
    (";", &[186]),
    ("'", &[222]),
    ("[", &[219]),
    ("]", &[221]),
    ("\\", &[220]),
    ("`", &[192]),
];

fn vk_for_token(token: &str) -> Option<Vec<i32>> {
    for (name, codes) in NAMED {
        if *name == token {
            return Some(codes.to_vec());
        }
    }
    if token.len() == 1 {
        let c = token.chars().next().unwrap();
        if c.is_ascii_lowercase() && c.is_ascii_alphanumeric() {
            return Some(vec![c.to_ascii_uppercase() as i32]);
        }
    }
    if let Some(rest) = token.strip_prefix('f') {
        if let Ok(n) = rest.parse::<u32>() {
            if (1..=24).contains(&n) {
                return Some(vec![111 + n as i32]);
            }
        }
    }
    if let Some(rest) = token.strip_prefix("num") {
        if rest.len() == 1 {
            if let Some(d) = rest.chars().next().unwrap().to_digit(10) {
                return Some(vec![96 + d as i32]);
            }
        }
    }
    None
}

/// Groups of virtual-key codes; each group is satisfied when any member key is
/// physically down (left/right modifier equivalence).
pub fn shortcut_key_groups(accelerator: &str) -> Option<Vec<Vec<i32>>> {
    let parts: Vec<&str> = accelerator.split('+').map(str::trim).collect();
    if parts.is_empty() {
        return None;
    }
    let mut groups = Vec::with_capacity(parts.len());
    for part in &parts {
        let token = part.to_lowercase();
        groups.push(vk_for_token(&token)?);
    }
    Some(groups)
}

pub struct HotkeySpec {
    pub modifiers: u32,
    pub vk: u32,
}

/// Convert an Electron-style accelerator into RegisterHotKey modifiers + VK.
/// The key repeat guard (MOD_NOREPEAT) keeps OS auto-repeat from re-firing the
/// chord while it is held, matching the hold-to-open contract.
pub fn accelerator_to_hotkey(accelerator: &str) -> Option<HotkeySpec> {
    let parts: Vec<&str> = accelerator.split('+').map(str::trim).collect();
    if parts.is_empty() {
        return None;
    }
    let mut modifiers: u32 = 0;
    let mut vk: Option<u32> = None;
    for part in &parts {
        let token = part.to_lowercase();
        if token.is_empty() {
            return None;
        }
        match token.as_str() {
            "alt" | "option" => modifiers |= MOD_ALT,
            "control" | "ctrl" | "commandorcontrol" | "cmdorctrl" => modifiers |= MOD_CONTROL,
            "shift" => modifiers |= MOD_SHIFT,
            "super" | "meta" | "command" | "cmd" => modifiers |= MOD_WIN,
            _ => {
                if vk.is_some() {
                    return None;
                }
                let codes = vk_for_token(&token)?;
                vk = Some(codes[0] as u32);
            }
        }
    }
    Some(HotkeySpec {
        modifiers: modifiers | MOD_NOREPEAT,
        vk: vk?,
    })
}

/// True when every group has at least one physically held key
/// (GetAsyncKeyState), matching windows-bridge.ps1 `keysDown`.
pub fn keys_down(groups: &[Vec<i32>]) -> bool {
    for group in groups {
        if !group.iter().any(|vk| key_is_down(*vk)) {
            return false;
        }
    }
    true
}

/// Physical key state used by hold polling.
pub fn key_is_down(vk: i32) -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    unsafe {
        GetAsyncKeyState(vk);
        (GetAsyncKeyState(vk) as u16 & 0x8000) != 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_parse() {
        let g = shortcut_key_groups("Alt+V").unwrap();
        assert_eq!(g, vec![vec![18], vec![86]]);
        let g = shortcut_key_groups("Alt+Shift+S").unwrap();
        assert_eq!(g, vec![vec![18], vec![16], vec![83]]);
        let g = shortcut_key_groups("F4").unwrap();
        assert_eq!(g, vec![vec![115]]);
        let g = shortcut_key_groups("Ctrl+,").unwrap();
        assert_eq!(g, vec![vec![17], vec![188]]);
        assert!(shortcut_key_groups("Alt+ media").is_none());
    }

    #[test]
    fn hotkey_specs() {
        let spec = accelerator_to_hotkey("Alt+V").unwrap();
        assert_eq!(spec.vk, 86);
        assert_eq!(spec.modifiers & MOD_ALT, MOD_ALT);
        assert_eq!(spec.modifiers & MOD_NOREPEAT, MOD_NOREPEAT);
        let spec = accelerator_to_hotkey("Alt+Shift+S").unwrap();
        assert_eq!(spec.vk, 83);
        assert!(accelerator_to_hotkey("V+V").is_none());
    }
}
