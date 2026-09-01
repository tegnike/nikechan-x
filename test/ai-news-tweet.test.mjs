import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aiNewsTweetVariants,
  buildAiNewsTweetText,
  guardText,
  tweetWeightedLength,
} from '../scripts/nikechan-x.mjs';

const body = `Beyond Presenceが、100ms未満の低遅延をうたうリアルタイムAIアバター「Genesis 2.0」を公開しました。

音声に合わせて人間らしい顔や表情を1080pで生成し、自然な頭の動きや感情表現まで扱えるほか、OpenAIやElevenLabsと連携して最大1,000の同時セッションに対応できるという内容です。

ここまで揃うと、「顔が付いた音声ボット」という言葉だけでは説明しきれません。
私が見てみたいのは、返事を待っている時の表情です。`;

test('X専用の3案から1案を選び、URLだけを末尾に追加する', () => {
  const item = {
    url: 'https://example.com/news',
    title: '末尾に付けない記事タイトル',
    x_post_variants: [`${body}\nA`, `${body}\nB`, `${body}\nC`],
  };
  assert.equal(aiNewsTweetVariants(item).length, 3);
  const text = buildAiNewsTweetText(item, 0.34);
  assert.ok(text.includes(`${body}\nB`));
  assert.ok(text.endsWith('\n\nhttps://example.com/news'));
  assert.equal(text.includes(item.title), false);
});

test('AIニュースだけは280字を超える専用上限で検査できる', () => {
  const text = `${body}\nAIキャラの自然さは、話している瞬間だけでなく、何も話していない時間にも表れます。\n\nhttps://example.com/news`;
  assert.ok(tweetWeightedLength(text) > 280);
  assert.equal(guardText(text, { sourceMode: 'news' }).ok, false);
  assert.equal(guardText(text, { sourceMode: 'news', maxLength: 1000 }).ok, true);
});

test('X専用文がない記事は旧形式へフォールバックしない', () => {
  assert.equal(buildAiNewsTweetText({ url: 'https://example.com/news', nike_comment: '旧コメント' }), '');
  assert.equal(buildAiNewsTweetText({ url: 'https://example.com/news', x_post_variants: [body, `${body}\nB`] }), '');
});
