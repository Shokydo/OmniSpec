// Disposable GUI fixture for an isolated Windows test runner. It is NOT
// Wallpaper Engine. Compile with rustc, then the test runner signs its copy
// with an ephemeral certificate trusted ONLY inside the disposable runner.
#![windows_subsystem = "windows"]
use std::ffi::c_void;
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, Ordering};

type Handle = *mut c_void;
#[repr(C)] struct Point { x:i32, y:i32 }
#[repr(C)] struct Rect { left:i32, top:i32, right:i32, bottom:i32 }
#[repr(C)] struct Message { hwnd:Handle, message:u32, wparam:usize, lparam:isize, time:u32, point:Point, private:u32 }
#[repr(C)] struct Paint { hdc:Handle, erase:i32, rect:Rect, restore:i32, inc:i32, reserved:[u8;32] }
#[repr(C)] struct WindowClass {
    style:u32, proc:Option<unsafe extern "system" fn(Handle,u32,usize,isize)->isize>,
    class_extra:i32, window_extra:i32, instance:Handle, icon:Handle, cursor:Handle,
    background:Handle, menu:*const u16, class:*const u16,
}
#[link(name="user32")]
extern "system" {
    fn RegisterClassW(class:*const WindowClass)->u16;
    fn CreateWindowExW(ex:u32,class:*const u16,name:*const u16,style:u32,x:i32,y:i32,w:i32,h:i32,parent:Handle,menu:Handle,instance:Handle,param:Handle)->Handle;
    fn DefWindowProcW(hwnd:Handle,msg:u32,w:usize,l:isize)->isize;
    fn FindWindowW(class:*const u16,name:*const u16)->Handle;
    fn PostMessageW(hwnd:Handle,msg:u32,w:usize,l:isize)->i32;
    fn PostQuitMessage(code:i32);
    fn GetMessageW(msg:*mut Message,hwnd:Handle,min:u32,max:u32)->i32;
    fn TranslateMessage(msg:*const Message)->i32;
    fn DispatchMessageW(msg:*const Message)->isize;
    fn SetTimer(hwnd:Handle,id:usize,ms:u32,callback:Handle)->usize;
    fn InvalidateRect(hwnd:Handle,rect:*const Rect,erase:i32)->i32;
    fn BeginPaint(hwnd:Handle,paint:*mut Paint)->Handle;
    fn EndPaint(hwnd:Handle,paint:*const Paint)->i32;
    fn FillRect(dc:Handle,rect:*const Rect,brush:Handle)->i32;
}
#[link(name="gdi32")]
extern "system" { fn CreateSolidBrush(color:u32)->Handle; fn DeleteObject(object:Handle)->i32; }
#[link(name="kernel32")]
extern "system" { fn GetModuleHandleW(name:*const u16)->Handle; }
static BLUE:AtomicBool=AtomicBool::new(false);
fn wide(s:&str)->Vec<u16>{s.encode_utf16().chain(Some(0)).collect()}
unsafe extern "system" fn procedure(hwnd:Handle,msg:u32,w:usize,l:isize)->isize {
    match msg {
        0x0113 => { BLUE.fetch_xor(true,Ordering::Relaxed); InvalidateRect(hwnd,null(),1); 0 }, // WM_TIMER
        0x000F => { // WM_PAINT
            let mut paint:Paint=std::mem::zeroed();
            let dc=BeginPaint(hwnd,&mut paint);
            let color=if BLUE.load(Ordering::Relaxed){0x00d02010}else{0x001020d0}; // COLORREF BGR
            let brush=CreateSolidBrush(color); FillRect(dc,&paint.rect,brush); DeleteObject(brush); EndPaint(hwnd,&paint); 0
        },
        0x0002 => { PostQuitMessage(0); 0 }, // WM_DESTROY
        _ => DefWindowProcW(hwnd,msg,w,l)
    }
}
fn value(args:&[String],key:&str)->Option<String>{args.windows(2).find(|p|p[0]==key).map(|p|p[1].clone())}
fn main(){
    let args:Vec<String>=std::env::args().skip(1).collect();
    match value(&args,"-control").as_deref(){
        Some("closeWallpaper") => if let Some(title)=value(&args,"-location") { unsafe {
            let hwnd=FindWindowW(null(),wide(&title).as_ptr()); if !hwnd.is_null(){PostMessageW(hwnd,0x0010,0,0);}
        }},
        Some("openWallpaper") => if let Some(title)=value(&args,"-playInWindow") { unsafe {
            let class=wide("OmniSpecTestingWindow"); let title=wide(&title); let instance=GetModuleHandleW(null());
            let wc=WindowClass{style:0,proc:Some(procedure),class_extra:0,window_extra:0,instance,icon:null_mut(),cursor:null_mut(),background:null_mut(),menu:null(),class:class.as_ptr()};
            if RegisterClassW(&wc)==0{return;}
            let hwnd=CreateWindowExW(0,class.as_ptr(),title.as_ptr(),0x80000000|0x10000000,
                40,40,320,240,null_mut(),null_mut(),instance,null_mut());
            if hwnd.is_null(){return;} SetTimer(hwnd,1,350,null_mut());
            let mut msg:Message=std::mem::zeroed();
            while GetMessageW(&mut msg,null_mut(),0,0)>0 {TranslateMessage(&msg);DispatchMessageW(&msg);}
        }},
        _ => {}
    }
}
