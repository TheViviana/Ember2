// Windows release 不分配控制台；debug 构建保留终端便于排查。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ember_lib::run()
}
