import { SaxesParser } from 'saxes';
import { HttpError, invalid } from './http';

const meta = 'adobe:ns:meta/';
const rdf = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const exif = 'http://ns.adobe.com/exif/1.0/';
const photoshop = 'http://ns.adobe.com/photoshop/1.0/';
const xmp = 'http://ns.adobe.com/xap/1.0/';
const tiff = 'http://ns.adobe.com/tiff/1.0/';
const xmlns = 'http://www.w3.org/2000/xmlns/';
const fields = new Set([
  `${exif}|UserComment`,
  `${photoshop}|DateCreated`,
  `${xmp}|ModifyDate`,
  `${tiff}|Orientation`,
]);
const namespaces = new Set([meta, rdf, exif, photoshop, xmp, tiff]);
export const xmpFailure = (reason: string): never =>
  invalid('assetData', `XMP ${reason}；请保留原件并联系管理员检查兼容性`);

// Deliberately narrow static metadata allowlist; absence of markers is not proof of provenance.
export function checkStaticXmp(bytes: Uint8Array) {
  if (!bytes.length) return xmpFailure('内容不能为空');
  if (bytes.length > 32768) return xmpFailure('元数据最多 32 KiB');
  try {
    const xml = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    const parser = new SaxesParser({ xmlns: true });
    const stack: string[] = [];
    const seen = new Set<string>();
    let descriptions = 0,
      elements = 0;
    parser.on('error', () => xmpFailure('XML 格式不完整或无效'));
    parser.on('doctype', () => xmpFailure('不支持 DTD 或自定义实体声明'));
    parser.on('processinginstruction', () => xmpFailure('不支持处理指令'));
    parser.on('opentag', (tag) => {
      if (++elements > 32) return xmpFailure('最多包含 32 个 XML 元素');
      const key = `${tag.uri}|${tag.local}`;
      const depth = stack.length;
      if (
        (depth === 0 && key !== `${meta}|xmpmeta`) ||
        (depth === 1 && key !== `${rdf}|RDF`) ||
        (depth === 2 && (key !== `${rdf}|Description` || ++descriptions !== 1)) ||
        depth > 3
      )
        return xmpFailure('仅支持单个 Description 中的简单文本字段');
      if (depth === 3) {
        if (!fields.has(key)) return xmpFailure('含尚不支持的元数据字段');
        if (seen.has(key)) return xmpFailure('同一元数据字段不能重复');
        seen.add(key);
      }
      for (const attr of Object.values(tag.attributes)) {
        const name = `${attr.uri}|${attr.local}`;
        if (attr.uri === xmlns) {
          if (!namespaces.has(attr.value)) return xmpFailure('含尚不支持的命名空间');
        } else if (depth === 0 && name === `${meta}|xmptk`) {
          /* descriptive toolkit text */
        } else if (depth === 2 && name === `${rdf}|about` && attr.value === '') {
          /* default subject */
        } else if (depth === 2 && fields.has(name)) {
          if (seen.has(name)) return xmpFailure('同一元数据字段不能重复');
          seen.add(name);
        } else return xmpFailure('含尚不支持的属性或属性位置');
      }
      stack.push(key);
    });
    const text = (value: string) => {
      if (stack.length !== 4 && value.trim()) xmpFailure('文本只能出现在元数据字段中');
    };
    parser.on('text', text);
    parser.on('cdata', text);
    parser.on('closetag', () => {
      stack.pop();
    });
    parser.write(xml).close();
    if (descriptions !== 1 || stack.length) return xmpFailure('必须包含单个完整的 Description');
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return xmpFailure('必须为有效的 UTF-8 XML');
  }
}

export function checkPngXmp(data: Uint8Array, type: string) {
  const keyword = 'XML:com.adobe.xmp\0';
  if (!Array.from(keyword).every((c, i) => data[i] === c.charCodeAt(0))) return false;
  let start = keyword.length;
  // No decompression: bounds must hold before parsing XML.
  if (type === 'zTXt') return xmpFailure('暂不支持压缩的 PNG 元数据');
  if (type === 'iTXt') {
    if (data[start++] !== 0 || data[start++] !== 0)
      return xmpFailure('仅支持未压缩且压缩方法为 0 的 PNG iTXt');
    for (let i = 0; i < 2; i++) {
      const end = data.indexOf(0, start);
      if (end < 0 || end - start > 256)
        return xmpFailure('PNG iTXt 语言及关键字头必须完整且各不超过 256 字节');
      start = end + 1;
    }
  }
  checkStaticXmp(data.subarray(start));
  return true;
}
