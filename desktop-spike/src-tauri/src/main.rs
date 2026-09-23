#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::process::Command;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let exe_dir = std::env::current_exe()?.parent().unwrap().to_path_buf();
            let node = exe_dir.join("node.exe");
            let res = std::path::PathBuf::from(app.path().resource_dir()?.join("sidecar").to_string_lossy().trim_start_matches("\\\\?\\"));
            let script = res.join("spike-audio.mjs");
            let out = std::env::temp_dir().join("spike-result.json");
            let _ = std::fs::remove_file(&out);
            let log = std::env::temp_dir().join("spike-rust.log");
            let msg = format!("node={:?} exists={} script={:?} exists={}
", node, node.exists(), script, script.exists());
            let _ = std::fs::write(&log, msg);
            let errf = std::fs::File::create(std::env::temp_dir().join("spike-node.err")).unwrap();
            let outf = errf.try_clone().unwrap();
            match Command::new(&node).arg(&script).arg(&out).current_dir(&res).stdout(outf).stderr(errf).spawn() {
                Ok(c) => { let _ = std::fs::write(&log, format!("spawned pid {} res={:?}", c.id(), res)); }
                Err(e) => { let _ = std::fs::write(&log, format!("spawn error: {e}")); }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("erreur tauri");
}
