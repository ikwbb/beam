//! Narrow synchronous ABI. JavaScript owns handles, validates dimensions and
//! serializes calls in a worker. All RFC6330 mathematics belongs to raptorq.
use std::{cell::RefCell, collections::HashMap};
use raptorq::{ObjectTransmissionInformation as Oti, SourceBlockEncoder, SourceBlockDecoder, EncodingPacket, PayloadId};
thread_local! {
 static ENCODERS: RefCell<HashMap<u32,SourceBlockEncoder>> = RefCell::new(HashMap::new());
 static DECODERS: RefCell<HashMap<u32,SourceBlockDecoder>> = RefCell::new(HashMap::new());
 static NEXT: RefCell<u32> = const {RefCell::new(1)};
 static OUTPUT: RefCell<Vec<u8>> = const {RefCell::new(Vec::new())};
}
fn handle()->u32 {NEXT.with(|n| {let mut n=n.borrow_mut(); let h=*n;*n+=1;h})}
fn config(len:u32,size:u32)->Oti {Oti::new(len as u64,size as u16,1,1,1)}
#[unsafe(no_mangle)] pub extern "C" fn alloc(len:u32)->*mut u8 {Box::into_raw(vec![0u8;len as usize].into_boxed_slice()) as *mut u8}
#[unsafe(no_mangle)] pub unsafe extern "C" fn dealloc(ptr:*mut u8,len:u32) {unsafe {drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr,len as usize)));}}
#[unsafe(no_mangle)] pub unsafe extern "C" fn encoder_new(ptr:*const u8,len:u32,size:u32)->u32 {
 let mut data=unsafe {std::slice::from_raw_parts(ptr,len as usize)}.to_vec(); data.resize((len as usize).div_ceil(size as usize)*size as usize,0); let h=handle();
 ENCODERS.with(|m|m.borrow_mut().insert(h,SourceBlockEncoder::new(0,&config(len,size),&data)));h
}
#[unsafe(no_mangle)] pub extern "C" fn encoder_repair(h:u32,offset:u32)->u32 {
 let p=ENCODERS.with(|m|m.borrow().get(&h).unwrap().repair_packets(offset,1).pop().unwrap());
 let esi=p.payload_id().encoding_symbol_id();OUTPUT.with(|o|*o.borrow_mut()=p.data().to_vec());esi
}
#[unsafe(no_mangle)] pub extern "C" fn encoder_free(h:u32) {ENCODERS.with(|m|m.borrow_mut().remove(&h));}
#[unsafe(no_mangle)] pub extern "C" fn decoder_new(len:u32,size:u32)->u32 {
 let h=handle();DECODERS.with(|m|m.borrow_mut().insert(h,SourceBlockDecoder::new(0,&config(len,size),len as u64)));h
}
#[unsafe(no_mangle)] pub unsafe extern "C" fn decoder_add(h:u32,esi:u32,ptr:*const u8,len:u32)->u32 {
 let data=unsafe {std::slice::from_raw_parts(ptr,len as usize)}.to_vec();
 let result=DECODERS.with(|m|m.borrow_mut().get_mut(&h).unwrap().decode([EncodingPacket::new(PayloadId::new(0,esi),data)]));
 if let Some(bytes)=result {OUTPUT.with(|o|*o.borrow_mut()=bytes);1} else {0}
}
#[unsafe(no_mangle)] pub extern "C" fn decoder_free(h:u32) {DECODERS.with(|m|m.borrow_mut().remove(&h));}
#[unsafe(no_mangle)] pub extern "C" fn output_ptr()->*const u8 {OUTPUT.with(|o|o.borrow().as_ptr())}
#[unsafe(no_mangle)] pub extern "C" fn output_len()->u32 {OUTPUT.with(|o|o.borrow().len() as u32)}
