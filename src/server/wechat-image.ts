import {inflateSync} from 'node:zlib';
import {WechatServiceError} from './wechat-errors';

const crcTable=Uint32Array.from({length:256},(_,value)=>{let crc=value;for(let bit=0;bit<8;bit++)crc=(crc&1)?0xedb88320^(crc>>>1):crc>>>1;return crc>>>0;});
function crc32(bytes:Buffer):number {let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
const invalid=()=>new WechatServiceError('微信返回的小程序码图像不完整或格式无效','rejected');

function png(image:Buffer):void {
  let offset=8,width=0,height=0,depth=0,color=0,interlace=0,header=false,palette=false,ended=false,dataEnded=false;
  const data:Buffer[]=[];
  while(offset<image.length) {
    if(offset+12>image.length)throw invalid();const length=image.readUInt32BE(offset),type=image.toString('ascii',offset+4,offset+8),end=offset+12+length;
    if(end>image.length||!/^[A-Za-z]{4}$/.test(type)||crc32(image.subarray(offset+4,end-4))!==image.readUInt32BE(end-4))throw invalid();
    const bytes=image.subarray(offset+8,end-4);
    if(!header&&type!=='IHDR')throw invalid();
    if(type==='IHDR') {
      if(header||length!==13)throw invalid();header=true;width=bytes.readUInt32BE(0);height=bytes.readUInt32BE(4);depth=bytes[8];color=bytes[9];interlace=bytes[12];
      const depths:Record<number,number[]>={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
      if(!width||!height||width>4096||height>4096||width*height>4_000_000||!depths[color]?.includes(depth)||bytes[10]!==0||bytes[11]!==0||interlace>1)throw invalid();
    } else if(type==='PLTE') {if(data.length||palette||!length||length%3||length>768)throw invalid();palette=true;}
    else if(type==='IDAT') {if(dataEnded||color===3&&!palette)throw invalid();data.push(bytes);}
    else if(type==='IEND') {if(length||!data.length||end!==image.length)throw invalid();ended=true;offset=end;break;}
    else {if(data.length)dataEnded=true;if(type[0]===type[0].toUpperCase())throw invalid();}
    offset=end;
  }
  if(!header||!ended||!data.length)throw invalid();
  const channels=({0:1,2:3,3:1,4:2,6:4} as Record<number,number>)[color];
  const passes=interlace?[[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]]:[[0,0,1,1]];
  const rows=passes.map(([x,y,sx,sy])=>({width:Math.max(0,Math.ceil((width-x)/sx)),height:Math.max(0,Math.ceil((height-y)/sy))})).filter(pass=>pass.width&&pass.height).map(pass=>({height:pass.height,bytes:1+Math.ceil(pass.width*channels*depth/8)}));
  const expected=rows.reduce((total,row)=>total+row.height*row.bytes,0);if(expected>32_000_000)throw invalid();
  let pixels:Buffer;try {pixels=inflateSync(Buffer.concat(data),{maxOutputLength:expected+1});}catch {throw invalid();}
  if(pixels.length!==expected)throw invalid();let rowAt=0;
  for(const row of rows)for(let line=0;line<row.height;line++){if(pixels[rowAt]>4)throw invalid();rowAt+=row.bytes;}
}

function jpeg(image:Buffer):void {
  let offset=2,frame=false,scan=false,scanBytes=0,quantization=false,huffman=false;
  while(offset<image.length) {
    if(image[offset++]!==255)throw invalid();while(image[offset]===255)offset++;
    const marker=image[offset++];if(marker===undefined||marker===0||marker===0xd8)throw invalid();
    if(marker===0xd9){if(offset!==image.length||!frame||!scan||!scanBytes||!quantization||!huffman)throw invalid();return;}
    if(marker===1||marker>=0xd0&&marker<=0xd7)throw invalid();
    if(offset+2>image.length)throw invalid();const length=image.readUInt16BE(offset),end=offset+length;if(length<2||end>image.length)throw invalid();
    if([0xc0,0xc1,0xc2].includes(marker)) {
      if(frame||length<11)throw invalid();const precision=image[offset+2],height=image.readUInt16BE(offset+3),width=image.readUInt16BE(offset+5),components=image[offset+7];
      if(precision!==8||!width||!height||width>4096||height>4096||width*height>4_000_000||![1,3,4].includes(components)||length!==8+3*components)throw invalid();frame=true;
    } else if(marker>=0xc0&&marker<=0xcf&&![0xc4,0xc8,0xcc].includes(marker))throw invalid();
    if(marker===0xdb)quantization=true;if(marker===0xc4)huffman=true;
    if(marker!==0xda){offset=end;continue;}
    if(!frame||length<6)throw invalid();const components=image[offset+2];if(![1,2,3,4].includes(components)||length!==6+2*components)throw invalid();scan=true;offset=end;
    while(offset<image.length) {
      if(image[offset]!==255){scanBytes++;offset++;continue;}
      const next=image[offset+1];if(next===undefined)throw invalid();
      if(next===0){scanBytes++;offset+=2;continue;}
      if(next>=0xd0&&next<=0xd7){offset+=2;continue;}
      if(next===255){offset++;continue;}
      break;
    }
  }
  throw invalid();
}

/** Structural integrity plus PNG decompression; never accept a magic header as an image. */
export function validateWechatImage(image:Buffer):'image/png'|'image/jpeg' {
  if(!image.length||image.length>2_000_000)throw invalid();
  if(image.length>=8&&image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){png(image);return 'image/png';}
  if(image.length>=3&&image[0]===255&&image[1]===216&&image[2]===255){jpeg(image);return 'image/jpeg';}
  throw invalid();
}
