import { createHash } from 'node:crypto';
import { curlRequest } from './curl-request.mjs';
import { retryCurlUpload, readCurlRanges } from './curl-recovery.mjs';
import { readSample, requireCorpus } from './real-media-corpus.mjs';
export function localCorpusTransport(base, onAttempt = async () => {}) {
  const url = new URL(base);
  requireCorpus(
    url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      url.port &&
      url.pathname === '/' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    'server',
    '验收工具仅允许 127.0.0.1 的隔离本地服务，不接受公网地址',
  );
  return {
    async json(route, data, token) {
      const r = await curlRequest(new URL(route, url).href, {
        timeoutMs: 30000,
        maxResponseBytes: 1048576,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: Buffer.from(JSON.stringify(data)),
      });
      await onAttempt({ route, ...r.metrics });
      requireCorpus(
        !r.metrics.errorCode,
        'transport',
        '本地请求未完整返回，请查看脱敏传输报告并重试',
      );
      return { status: r.metrics.status, bytes: r.bytes };
    },
    async upload(entry, bytes, token) {
      const form = new FormData();
      form.set(
        'assetData',
        new File(
          [bytes],
          `sample-${entry.index}.${entry.expected.mime === 'image/png' ? 'png' : 'jpg'}`,
          { type: entry.expected.mime },
        ),
      );
      form.set('fileCreatedAt', '2026-10-17T00:00:00Z');
      form.set('fileModifiedAt', '2026-10-17T00:00:00Z');
      const request = new Request(url, { method: 'POST', body: form });
      const r = await retryCurlUpload(new URL('/api/assets', url).href, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': request.headers.get('content-type'),
          'x-immich-checksum': createHash('sha1').update(bytes).digest('hex'),
        },
        body: Buffer.from(await request.arrayBuffer()),
        onAttempt: (entry) => onAttempt({ route: '/api/assets', ...entry }),
      });
      requireCorpus(
        !r.metrics.errorCode,
        `samples.${entry.index}.upload`,
        '上传未完整确认，请检查传输报告后重试同一清单',
      );
      return { status: r.metrics.status, bytes: r.bytes };
    },
    async read(route, bytes, token) {
      const r = await readCurlRanges(new URL(route, url).href, {
        headers: { Authorization: `Bearer ${token}` },
        expected: bytes,
        onAttempt: (entry) => onAttempt({ route: '/api/assets/{id}/media', ...entry }),
      });
      requireCorpus(
        !r.metrics.errorCode && r.bytes.equals(bytes),
        'original',
        '原图或预览字节不一致，请保留输入样本并检查服务端',
      );
    },
    async detail(id, token) {
      const r = await curlRequest(new URL(`/api/assets/${id}`, url).href, {
        method: 'GET',
        timeoutMs: 30000,
        headers: { Authorization: `Bearer ${token}` },
      });
      await onAttempt({ route: '/api/assets/{id}', ...r.metrics });
      requireCorpus(
        !r.metrics.errorCode && r.metrics.status === 200,
        'detail',
        '资产详情读取失败，请检查本地服务后重试',
      );
      return JSON.parse(r.bytes);
    },
  };
}
export async function verifyCorpus(entries, { transport, account, onResult = async () => {} }) {
  const results = [];
  for (let batch = 0; batch < entries.length; batch += 20) {
    const token = await account();
    const saved = new Map();
    let primaryFailure;
    try {
      for (const entry of entries.slice(batch, batch + 20)) {
        const bytes = await readSample(entry),
          field = `samples.${entry.index}`;
        const r = await transport.upload(entry, bytes, token);
        const accepted = entry.expected.status === 201;
        let serverReason = '';
        if (r.status >= 400) {
          try {
            const error = JSON.parse(r.bytes);
            if (typeof error.message === 'string')
              serverReason = `；服务端：${error.message.slice(0, 512)}`;
          } catch {
            /* Preserve the status error when no JSON reason is available. */
          }
        }
        requireCorpus(
          accepted ? [200, 201].includes(r.status) : r.status === entry.expected.status,
          `${field}.expected.status`,
          `HTTP 结果与预期不符${serverReason}；请检查样本支持范围或修正清单`,
        );
        if (accepted) {
          const value = JSON.parse(r.bytes);
          const hash = createHash('sha1').update(bytes).digest('base64');
          if (saved.has(hash))
            requireCorpus(
              saved.get(hash).id === value.id,
              `${field}.duplicate`,
              '同一内容产生多个资产，请保留报告排查',
            );
          const retry = await transport.upload(entry, bytes, token);
          requireCorpus(
            retry.status === 200 && JSON.parse(retry.bytes).id === value.id,
            `${field}.duplicate`,
            '重复上传未返回同一资产，请保留报告排查',
          );
          await transport.read(`/api/assets/${value.id}/original`, bytes, token);
          await transport.read(`/api/assets/${value.id}/thumbnail?size=preview`, bytes, token);
          const detail = await transport.detail(value.id, token);
          requireCorpus(
            detail.originalMimeType === entry.expected.mime,
            `${field}.expected.mime`,
            '实际格式与清单不符，请修正独立期望格式',
          );
          const previous = saved.get(hash);
          saved.set(hash, { id: value.id, entries: [...(previous?.entries ?? []), entry] });
        }
        const result = {
          index: entry.index,
          accepted,
          passed: false,
          status: r.status,
          bytes: entry.size,
        };
        results.push(result);
        await onResult(result);
      }
      const stream = await transport.json(
        '/api/sync/stream',
        { types: ['UsersV1', 'AssetsV2'] },
        token,
      );
      requireCorpus(stream.status === 200, 'sync', '同步请求失败，请检查本地服务后重试');
      const events = stream.bytes.toString().trim().split('\n').map(JSON.parse);
      requireCorpus(
        events.at(-1)?.type === 'SyncCompleteV1',
        'sync',
        '同步未收到 Complete，请保留报告重试',
      );
      const assets = events.filter((e) => e.type === 'AssetV2');
      requireCorpus(
        assets.length === saved.size && new Set(assets.map((e) => e.data.id)).size === saved.size,
        'sync',
        '同步资产缺失或重复，请保留报告排查',
      );
      for (const { id, entries: matches } of saved.values())
        for (const entry of matches) {
          const asset = assets.find((e) => e.data.id === id)?.data;
          requireCorpus(
            asset && asset.width === entry.expected.width && asset.height === entry.expected.height,
            `samples.${entry.index}.expected.width/height`,
            '同步布局尺寸不符，请核对 EXIF 方向与独立期望尺寸',
          );
        }
      requireCorpus(
        (await transport.json('/api/sync/ack', { acks: events.map((e) => e.ack) }, token))
          .status === 204,
        'ack',
        'ACK 未成功，请检查本地服务后重试',
      );
      const incremental = await transport.json(
        '/api/sync/stream',
        { types: ['UsersV1', 'AssetsV2'] },
        token,
      );
      requireCorpus(
        incremental.status === 200 &&
          incremental.bytes
            .toString()
            .trim()
            .split('\n')
            .map(JSON.parse)
            .every((e) => e.type === 'SyncCompleteV1'),
        'sync',
        'ACK 后增量不为空，请保留报告排查',
      );
      for (const result of results.slice(batch, batch + 20)) {
        result.passed = true;
        await onResult(result);
      }
    } catch (error) {
      primaryFailure = error;
      throw error;
    } finally {
      try {
        requireCorpus(
          (await transport.json('/api/auth/logout', {}, token)).status === 200,
          'logout',
          '临时会话退出未确认，请保留隔离测试状态',
        );
      } catch (error) {
        if (!primaryFailure) throw error;
        primaryFailure.cleanupUnconfirmed = true;
      }
    }
  }
  return results;
}
