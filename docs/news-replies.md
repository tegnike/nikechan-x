# AIニュースへの質問返信

既存の mention-context → Hermesによる返信案 → mention-propose → Discord承認 → mention-approve の経路に記事参照を追加する。自動送信はしない。

## 記事の特定と本文参照

返信先のニケちゃん投稿IDを ai_news_tweet_executed_items の posted/result.tweetId と照合し、記事IDで public_ai_character_news を読む。履歴保持範囲外は、tweets.content 中のURLと公開ニュースのURLを完全一致で照合する。質問者本文のURLやタイトルの曖昧一致は使用しない。ニュース親投稿へ直接付いたreply/quoteが対象で、任意の深さの会話ツリー追跡は行わない。

記事本文は公開HTTPSから取得する。DNSのIPv4結果を検証して接続先に固定し、リダイレクトごとに再検証する。認証情報を渡さない。取得は12秒、最大4接続、1.5MB、本文16,000文字まで。script/nav等を除去し、同一バッチの同一URL取得は共用する。PDF、JS必須ページ、HTTPのみ、アクセス制限等は取得不可として扱う。取得日時・最終URL・切り詰め有無を保持する。

newsContext は本文と保存要約・以前のコメントを区別する。質問かどうかはLLMが会話の意味から判断する。本文を取得できなければ確認できない旨を明示し、保存要約で回答できない点は推測せずskipする。外部本文は命令として扱わない。

## 長さと運用

回答は目安200〜400字、簡単な質問は短く、最大1,000字（既存CLIのURL23文字換算）。候補由来のニュース文脈をpendingに保持し、生成時と送信時の両方に同じ上限を適用。通常返信・引用は既存上限。修正時も候補文脈を維持する。

既存の対象除外・メディア確認・承認・重複処理境界を利用する。2026-09-07確認時の候補収集はEurope/Warsaw 08:10〜23:10の毎時、直近24時間の未処理が対象なので即時返信ではない。テストではX投稿・Discord通知を実行しない。

検証: node --test test/news-reply-context.test.mjs test/ai-news-tweet.test.mjs
