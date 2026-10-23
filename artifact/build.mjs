// artifact/src.html にお題データを埋め込んで artifact/wordwolf.html を作る
import { readFileSync, writeFileSync } from 'node:fs';
import { TOPIC_PAIRS } from '../src/topics.js';
const dir = new URL('.', import.meta.url);
const topics = JSON.stringify(TOPIC_PAIRS.map((p) => [[p.a.word, p.a.hints], [p.b.word, p.b.hints]]));
const html = readFileSync(new URL('src.html', dir), 'utf8').replace('/*TOPICS*/[]', topics);
writeFileSync(new URL('wordwolf.html', dir), html);
console.log('artifact/wordwolf.html', html.length, 'bytes');
