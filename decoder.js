import { scanImageData, getDefaultScanner, ZBarSymbolType, ZBarConfigType } from './vendor/zbar.mjs';
let ready;
export async function decodeDetections(image) {
  ready ??= getDefaultScanner().then(scanner => {
    scanner.setConfig(ZBarSymbolType.ZBAR_NONE, ZBarConfigType.ZBAR_CFG_ENABLE, 0);
    scanner.setConfig(ZBarSymbolType.ZBAR_QRCODE, ZBarConfigType.ZBAR_CFG_ENABLE, 1);
    return scanner;
  });
  return (await scanImageData(image, await ready)).map(symbol => ({
    text: symbol.decode(), points: (symbol.points || []).map(({ x, y }) => ({ x, y })),
  }));
}

export async function decodeImage(image) {
  return (await decodeDetections(image)).map(code => code.text).filter(text => /^B[12]:/.test(text));
}
