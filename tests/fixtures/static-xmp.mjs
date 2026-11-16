export const staticXmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Test toolkit"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"><exif:UserComment>Screenshot</exif:UserComment><photoshop:DateCreated>2026-01-01T00:00:00</photoshop:DateCreated></rdf:Description></rdf:RDF></x:xmpmeta>`;

// Constructed metadata equivalent to the newer iOS screenshot layout; no private sample values.
export const screenshotXmp = staticXmp
  .replace(
    'xmlns:photoshop=',
    'xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:tiff="http://ns.adobe.com/tiff/1.0/" xmlns:photoshop=',
  )
  .replace(
    '</rdf:Description>',
    '<xmp:ModifyDate>2026-01-01T00:00:00</xmp:ModifyDate><tiff:Orientation>1</tiff:Orientation></rdf:Description>',
  );
