import { SaxesParser } from 'saxes';
import { invalid } from './http';

const meta = 'adobe:ns:meta/';
const rdf = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const exif = 'http://ns.adobe.com/exif/1.0/';
const photoshop = 'http://ns.adobe.com/photoshop/1.0/';
const xmlns = 'http://www.w3.org/2000/xmlns/';
const fields = new Set([`${exif}|UserComment`, `${photoshop}|DateCreated`]);
const namespaces = new Set([meta, rdf, exif, photoshop]);
export const xmpFailure = (): never =>
  invalid(
    'assetData',
    'XMP 含不支持的字段、动态照片关联或异常结构，暂不能安全上传；请保留原件并从当前备份相册移除此项',
  );

// Deliberately narrow static metadata allowlist; absence of markers is not proof of provenance.
export function checkStaticXmp(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > 32768) return xmpFailure();
  try {
    const xml = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    const parser = new SaxesParser({ xmlns: true });
    const stack: string[] = [];
    const seen = new Set<string>();
    let descriptions = 0,
      elements = 0;
    parser.on('error', xmpFailure);
    parser.on('doctype', xmpFailure);
    parser.on('processinginstruction', xmpFailure);
    parser.on('opentag', (tag) => {
      if (++elements > 32) return xmpFailure();
      const key = `${tag.uri}|${tag.local}`;
      const depth = stack.length;
      if (
        (depth === 0 && key !== `${meta}|xmpmeta`) ||
        (depth === 1 && key !== `${rdf}|RDF`) ||
        (depth === 2 && (key !== `${rdf}|Description` || ++descriptions !== 1)) ||
        (depth === 3 && (!fields.has(key) || seen.has(key))) ||
        depth > 3
      )
        return xmpFailure();
      if (depth === 3) seen.add(key);
      for (const attr of Object.values(tag.attributes)) {
        const name = `${attr.uri}|${attr.local}`;
        if (attr.uri === xmlns) {
          if (!namespaces.has(attr.value)) return xmpFailure();
        } else if (depth === 0 && name === `${meta}|xmptk`) {
          /* descriptive toolkit text */
        } else if (depth === 2 && name === `${rdf}|about` && attr.value === '') {
          /* default subject */
        } else if (depth === 2 && fields.has(name) && !seen.has(name)) seen.add(name);
        else return xmpFailure();
      }
      stack.push(key);
    });
    const text = (value: string) => {
      if (stack.length !== 4 && value.trim()) xmpFailure();
    };
    parser.on('text', text);
    parser.on('cdata', text);
    parser.on('closetag', () => {
      stack.pop();
    });
    parser.write(xml).close();
    if (descriptions !== 1 || stack.length) return xmpFailure();
  } catch {
    return xmpFailure();
  }
}

export function checkPngXmp(data: Uint8Array, type: string) {
  const keyword = 'XML:com.adobe.xmp\0';
  if (!Array.from(keyword).every((c, i) => data[i] === c.charCodeAt(0))) return false;
  let start = keyword.length;
  // No decompression: bounds must hold before parsing XML.
  if (type === 'zTXt') return xmpFailure();
  if (type === 'iTXt') {
    if (data[start++] !== 0 || data[start++] !== 0) return xmpFailure();
    for (let i = 0; i < 2; i++) {
      const end = data.indexOf(0, start);
      if (end < 0 || end - start > 256) return xmpFailure();
      start = end + 1;
    }
  }
  checkStaticXmp(data.subarray(start));
  return true;
}
