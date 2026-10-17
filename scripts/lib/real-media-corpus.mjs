import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MAX_IMAGE_EDGE, MAX_IMAGE_PIXELS } from '../../src/poc/image-limits.ts';
export class CorpusError extends Error {
  constructor(field, reason) {
    super(`${field}：${reason}`);
    this.field = field;
  }
}
export const requireCorpus = (ok, field, reason) => {
  if (!ok) throw new CorpusError(field, reason);
};
export async function loadCorpus(manifestFile) {
  const root = await realpath(path.dirname(manifestFile));
  const info = await stat(manifestFile);
  requireCorpus(info.size <= 262144, 'manifest', '最多 256 KiB，请减少条目');
  let data;
  try {
    data = JSON.parse(await readFile(manifestFile, 'utf8'));
  } catch {
    throw new CorpusError('manifest', '必须为有效 JSON 对象，请检查格式');
  }
  requireCorpus(data?.version === 1, 'version', '必须为 1');
  requireCorpus(
    Array.isArray(data.samples) && data.samples.length > 0 && data.samples.length <= 200,
    'samples',
    '请提供 1～200 项样本',
  );
  const entries = [];
  let total = 0;
  for (const [index, sample] of data.samples.entries()) {
    const field = `samples.${index}`;
    requireCorpus(sample && typeof sample === 'object', field, '必须为样本对象');
    requireCorpus(
      typeof sample.file === 'string' &&
        sample.file.length > 0 &&
        !path.isAbsolute(sample.file) &&
        !sample.file.split(/[\\/]/).includes('..') &&
        !/[:\0]/.test(sample.file),
      `${field}.file`,
      '请使用清单目录内相对路径，不得越界或包含驱动器/数据流',
    );
    requireCorpus(
      ['user-original', 'synthetic-fixture'].includes(sample.provenance),
      `${field}.provenance`,
      '必须为 user-original 或 synthetic-fixture，不得将合成变体申报为真实照片',
    );
    requireCorpus(
      typeof sample.captureId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(sample.captureId),
      `${field}.captureId`,
      '请填写 1～64 位非隐私字母数字标识；同次拍摄的变体使用同一标识',
    );
    const expected = sample.expected;
    requireCorpus(
      expected && [201, 400, 413].includes(expected.status),
      `${field}.expected.status`,
      '必须为 201（支持）或 400/413（预期拒绝）',
    );
    requireCorpus(
      ['image/jpeg', 'image/png'].includes(expected.mime),
      `${field}.expected.mime`,
      '必须为 image/jpeg 或 image/png',
    );
    if (expected.status === 201)
      for (const dimension of ['width', 'height'])
        requireCorpus(
          Number.isInteger(expected[dimension]) &&
            expected[dimension] > 0 &&
            expected[dimension] <= MAX_IMAGE_EDGE,
          `${field}.expected.${dimension}`,
          '请填写独立确认的布局尺寸，范围 1～16384',
        );
    if (expected.status === 201)
      requireCorpus(
        expected.width * expected.height <= MAX_IMAGE_PIXELS,
        `${field}.expected.width/height`,
        '布局尺寸：总像素最多 6400 万，请核对独立尺寸或将超限项标为预期拒绝',
      );
    let file;
    try {
      file = await realpath(path.resolve(root, sample.file));
    } catch {
      throw new CorpusError(`${field}.file`, '文件不可读取，请放入清单目录后重试');
    }
    const relative = path.relative(root, file);
    requireCorpus(
      relative !== '' &&
        !relative.startsWith('..' + path.sep) &&
        relative !== '..' &&
        !path.isAbsolute(relative),
      `${field}.file`,
      '文件或链接必须位于清单目录内',
    );
    const fileInfo = await stat(file);
    requireCorpus(fileInfo.isFile(), `${field}.file`, '必须指向普通样本文件，不接受目录');
    const size = fileInfo.size;
    total += size;
    requireCorpus(
      size > 0 && size <= 8 * 1024 * 1024,
      `${field}.file`,
      '每个样本须为 1 字节～8 MiB；更大文件请另做超限验收',
    );
    requireCorpus(total <= 1024 * 1024 * 1024, 'samples', '样本总量最多 1 GiB，请分批验收');
    const bytes = await readFile(file);
    entries.push({
      index,
      file,
      size,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      provenance: sample.provenance,
      captureId: sample.captureId,
      expected,
    });
  }
  return entries;
}
export async function readSample(entry) {
  const info = await stat(entry.file);
  requireCorpus(
    info.size === entry.size,
    `samples.${entry.index}.file`,
    '样本已改变，请重新运行清单预检',
  );
  const bytes = await readFile(entry.file);
  requireCorpus(
    createHash('sha256').update(bytes).digest('hex') === entry.sha256,
    `samples.${entry.index}.file`,
    '样本已改变，请重新运行清单预检',
  );
  return bytes;
}
export function corpusSummary(entries, results) {
  const passed = new Set(results.filter((r) => r.accepted && r.passed).map((r) => r.index));
  const real = entries.filter((e) => passed.has(e.index) && e.provenance === 'user-original');
  const contents = new Set(real.map((e) => e.sha256)).size,
    captures = new Set(real.map((e) => e.captureId)).size;
  const formats = new Set(real.map((e) => e.expected.mime));
  const threshold =
    contents >= 100 && captures >= 100 && formats.has('image/jpeg') && formats.has('image/png');
  return {
    samples: entries.length,
    accepted: passed.size,
    acceptedUniqueContents: new Set(entries.filter((e) => passed.has(e.index)).map((e) => e.sha256))
      .size,
    declaredRealEntries: real.length,
    declaredRealUniqueContents: contents,
    declaredRealUniqueCaptures: captures,
    syntheticEntries: entries.filter((e) => e.provenance === 'synthetic-fixture').length,
    declaredRealThresholdMet: threshold,
    provenanceIndependentlyVerified: false,
    fullDecodeVerified: false,
    officialAppVerified: false,
    g1Passed: false,
  };
}
