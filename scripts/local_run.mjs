// 本地实测：用内存 KV 桩 + 真实网络跑一轮完整聚合（未来 7 天），
// 打印各天条目数、补名命中数与样本标题。
// 用法：node scripts/local_run.mjs
// 可选：TMDB_TOKEN=<只读访问令牌> node scripts/local_run.mjs
//       未提供 TMDB_TOKEN 时聚合照常跑，仅跳过 TMDB 步（aka 兜底仍在）。
import { aggregate } from '../src/index.js';

class MemoryKV {
  constructor() {
    this.map = new Map();
  }
  async get(key, opts) {
    const v = this.map.get(key);
    if (v == null) return null;
    if (opts && opts.type === 'json') {
      try {
        return JSON.parse(v);
      } catch {
        return null;
      }
    }
    return v;
  }
  async put(key, value) {
    this.map.set(key, String(value));
  }
  async delete(key) {
    this.map.delete(key);
  }
}

const hasCjk = (s) => /[\u4E00-\u9FFF]/.test(s ?? '');

const env = {
  CACHE: new MemoryKV(),
  TMDB_TOKEN: process.env.TMDB_TOKEN || null,
  REFRESH_KEY: null,
};

console.log('== hbcalendar local run ==');
console.log(`node: ${process.version}`);
console.log(`TMDB_TOKEN: ${env.TMDB_TOKEN ? 'configured (TMDB 步启用)' : 'NOT set (跳过 TMDB 步)'}`);

const stats = await aggregate(env);
console.log(`\n聚合完成：${stats.durationMs} ms，解析 show ${stats.showsResolved} 部`);
console.log('逐日统计（date: entries / tmdbNamed / akaNamed）：');
for (const [d, c] of Object.entries(stats.days)) {
  console.log(`  ${d}: ${c.entries} / ${c.tmdbNamed} / ${c.akaNamed}`);
}

// 汇总全部快照做样本核对
const all = [];
for (const d of Object.keys(stats.days)) {
  const snap = await env.CACHE.get(`day:${d}`, { type: 'json' });
  if (snap) all.push(...snap.entries.map((e) => ({ day: d, ...e })));
}
const cjkTitles = [...new Set(all.filter((e) => hasCjk(e.showTitle)).map((e) => e.showTitle))];
console.log(`\n总条目 ${all.length}，其中中文标题条目 ${all.filter((e) => hasCjk(e.showTitle)).length}，不同中文剧名 ${cjkTitles.length} 个`);
console.log('中文剧名样本（前 20）：');
for (const t of cjkTitles.slice(0, 20)) console.log(`  ${t}`);

// 点名核对：这几部必须以中文名出现，拼音/英文原名出现即算失败
const watch = ['吞噬星空', '逆天至尊', '尚公主', '以下犯上', '折月亮', '天命·成凰'];
console.log('\n点名核对：');
for (const t of watch) {
  const hit = all.find((e) => e.showTitle === t);
  console.log(`  ${t}: ${hit ? `OK（${hit.day} ${hit.source}）` : '未在未来 7 天排期中找到'}`);
}
const pinyin = all.filter((e) => e.showTitle === 'Tunshi Xingkong');
console.log(`  拼音残留 'Tunshi Xingkong': ${pinyin.length} 条${pinyin.length ? ' ← 异常！' : '（正常）'}`);

const withTmdbCover = all.filter((e) => e.tmdbCoverUrl).length;
console.log(`\n带 tmdbCoverUrl 的条目：${withTmdbCover}`);
console.log('== done ==');
