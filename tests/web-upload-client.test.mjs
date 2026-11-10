import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('wrangler'))('esbuild');
const bundle = await build({
  entryPoints: [path.resolve('web/src/upload-client.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { uploadEntries, uploadEntry, uploadFile, UploadError } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
);
const limits = {
  photoBytes: 20_000_000,
  motionBytes: 64 * 1024 ** 2,
  photoExtensions: ['jpg', 'jpeg', 'png', 'heic', 'heif'],
  maxPixels: 64_000_000,
  maxEdge: 16384,
};
const file = (name, content = 'original') =>
  new File([content], name, { lastModified: Date.parse('2026-11-01T01:02:03.000Z') });
const originalWindow = globalThis.window,
  originalXHR = globalThis.XMLHttpRequest;
globalThis.window = new EventTarget();
let sent = [],
  onSend = () => {};
class FakeXHR {
  upload = {};
  headers = {};
  open(method, url) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name, value) {
    this.headers[name] = value;
  }
  send(body) {
    this.body = body;
    sent.push(this);
    onSend(this);
  }
  abort() {
    this.onabort?.();
  }
  respond(status, body) {
    this.status = status;
    this.responseText = typeof body === 'string' ? body : JSON.stringify(body);
    this.onload();
  }
}
globalThis.XMLHttpRequest = FakeXHR;
after(() => {
  globalThis.window = originalWindow;
  globalThis.XMLHttpRequest = originalXHR;
});
function startUpload(source = file('photo.jpg'), controller = new AbortController()) {
  let ready;
  const started = new Promise((resolve) => {
    ready = resolve;
  });
  onSend = (xhr) => ready(xhr);
  const progress = [];
  const result = uploadFile(source, {}, (...value) => progress.push(value), controller.signal);
  return { started, result, progress, controller };
}

test('文件选择按同名匹配 Live Photo，拒绝歧义和独立 MOV，大小/名称错误具体到字段', () => {
  const jpg = file('IMG_001.HEIC'),
    mov = file('img_001.MOV');
  const [pair] = uploadEntries([mov, jpg], limits);
  assert.equal(pair.file, jpg);
  assert.equal(pair.motion, mov);
  assert.equal(pair.error, '');
  assert.match(uploadEntries([mov], limits)[0].error, /动态照片配对.*同名.*独立视频/);
  assert.ok(
    uploadEntries([jpg, file('IMG_001.jpg'), mov], limits).every((entry) =>
      /不支持|分批选择/.test(entry.error),
    ),
  );
  for (const [source, reason] of [
    [file('empty.jpg', ''), /照片文件.*不能为空/],
    [file('../private.jpg'), /文件名.*不含路径/],
    [file('movie.mp4'), /照片文件.*请选择/],
    [file('large.jpg', new Uint8Array(limits.photoBytes + 1)), /照片文件.*20,000,000/],
  ]) {
    assert.match(uploadEntries([source], limits)[0].error, reason);
  }
  assert.match(
    uploadEntries([file('photo.heic')], {
      ...limits,
      motionBytes: 0,
      photoExtensions: ['jpg', 'png'],
    })[0].error,
    /照片文件.*JPG/,
  );
});

test('配对先保存 MOV 再提交照片，失败重试复用已确认动态 ID，停止后不发照片', async () => {
  const entry = uploadEntries([file('pair.jpg'), file('pair.mov')], limits)[0],
    motionId = randomUUID(),
    photoId = randomUUID();
  const calls = [],
    progress = [],
    saved = [];
  const send = async (source, fields, update) => {
    calls.push({ name: source.name, fields });
    update(1, true);
    if (source.name.endsWith('.jpg')) throw new UploadError('照片文件：网络中断');
    return { id: motionId, status: 'created' };
  };
  await assert.rejects(
    uploadEntry(
      entry,
      (...value) => progress.push(value),
      new AbortController().signal,
      (id) => saved.push(id),
      send,
    ),
    /网络中断/,
  );
  assert.deepEqual(
    calls.map((x) => x.fields),
    [{ visibility: 'hidden' }, { livePhotoVideoId: motionId }],
  );
  assert.deepEqual(saved, [motionId]);
  assert.ok(progress[0][0] < 1);
  let retryCalls = 0;
  assert.equal(
    (
      await uploadEntry(
        { ...entry, motionId },
        () => {},
        new AbortController().signal,
        () => assert.fail('motion repeated'),
        async (source, fields) => {
          retryCalls++;
          assert.equal(source, entry.file);
          assert.equal(fields.livePhotoVideoId, motionId);
          return { id: photoId, status: 'created' };
        },
      )
    ).id,
    photoId,
  );
  assert.equal(retryCalls, 1);
  const stop = new AbortController();
  let motionSaved;
  await assert.rejects(
    uploadEntry(
      entry,
      () => {},
      stop.signal,
      (id) => {
        motionSaved = id;
        stop.abort();
      },
      async () => ({ id: motionId, status: 'created' }),
    ),
    { name: 'AbortError' },
  );
  assert.equal(motionSaved, motionId);
});

test('上传发送原始 File、SHA-1 和文件时间，100% 发送进度仍等待保存响应', async () => {
  const source = file('photo.jpg', 'unchanged-original'),
    task = startUpload(source),
    xhr = await task.started;
  assert.equal(xhr.method, 'POST');
  assert.equal(xhr.url, '/api/immich-cf/web/upload');
  assert.equal(xhr.withCredentials, true);
  assert.equal(xhr.headers['Content-Type'], undefined);
  assert.equal(
    xhr.headers['x-immich-checksum'],
    createHash('sha1').update('unchanged-original').digest('hex'),
  );
  assert.equal(await xhr.body.get('assetData').text(), 'unchanged-original');
  assert.equal(xhr.body.get('fileCreatedAt'), '2026-11-01T01:02:03.000Z');
  let resolved = false;
  task.result.then(() => {
    resolved = true;
  });
  xhr.upload.onprogress({ lengthComputable: true, loaded: 5, total: 10 });
  xhr.upload.onload();
  await Promise.resolve();
  assert.equal(resolved, false);
  assert.deepEqual(task.progress, [
    [0.5, false],
    [1, true],
  ]);
  const id = randomUUID();
  xhr.respond(201, { id, status: 'created' });
  assert.deepEqual(await task.result, { id, status: 'created' });
});

test('取消与网络中断保留未知结果语义，重试可确认 duplicate；无效成功响应不可报成功', async () => {
  const aborted = new AbortController();
  aborted.abort();
  const count = sent.length;
  await assert.rejects(
    uploadFile(file('photo.jpg'), {}, () => {}, aborted.signal),
    { name: 'AbortError' },
  );
  assert.equal(sent.length, count);
  const cancelled = startUpload();
  await cancelled.started;
  cancelled.controller.abort();
  await assert.rejects(cancelled.result, { name: 'AbortError' });
  const broken = startUpload(),
    xhr = await broken.started;
  xhr.onerror();
  await assert.rejects(
    broken.result,
    (error) => error.retryable && /重试同一原件.*不会重复/.test(error.message),
  );
  const retry = startUpload(),
    duplicate = randomUUID();
  (await retry.started).respond(200, { id: duplicate, status: 'duplicate' });
  assert.equal((await retry.result).status, 'duplicate');
  const invalid = startUpload();
  (await invalid.started).respond(200, '<html>bad proxy</html>');
  await assert.rejects(invalid.result, /未返回可确认的保存结果/);
});

test('上传保留服务端具体字段原因、区分可重试错误，并在 401 通知会话退出', async () => {
  for (const [status, body, text, retryable] of [
    [
      400,
      {
        message: '校验失败',
        errors: [{ path: ['assetData'], message: '像素超限，请缩小图片尺寸' }],
      },
      /照片文件.*像素超限.*缩小/,
      false,
    ],
    [413, '<html>limit</html>', /照片文件.*超过服务上限.*减少文件大小/, false],
    [
      503,
      { message: 'assetData：暂存文件未确认，请重新上传同一原件' },
      /照片文件.*暂存文件未确认/,
      true,
    ],
    [
      400,
      {
        errors: [{ path: ['livePhotoVideoId'], message: 'livePhotoVideoId：配对不符，请核对原件' }],
      },
      /动态照片配对.*配对不符.*同时选择同名/,
      false,
    ],
  ]) {
    const task = startUpload();
    (await task.started).respond(status, body);
    await assert.rejects(task.result, (error) => {
      assert.match(error.message, text);
      assert.equal(error.retryable, retryable);
      return true;
    });
  }
  let expired = 0;
  window.addEventListener(
    'session-expired',
    () => {
      expired++;
    },
    { once: true },
  );
  const task = startUpload();
  (await task.started).respond(401, { message: '会话已失效，请重新登录' });
  await assert.rejects(task.result, (error) => error.status === 401 && !error.retryable);
  assert.equal(expired, 1);
});
