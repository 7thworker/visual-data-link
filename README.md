# Visual Data Link

[English](#visual-data-link-english)

PC の画面に表示した模様をスマホのカメラで撮影して、ファイルを受け渡す Web アプリです。ブラウザだけで動き、ファイルの中身はネットワークを通りません。

このリポジトリは、GitHub Pages で公開しているページのファイルです。

## 使い方

1. PC でこのサイトのトップページを開き、「ファイルを送る」を押します。
2. スマホのカメラで、トップページか送信ページの QR コードを読み取って受信ページを開きます。
3. PC でファイルと送り方（標準・速い・互換）を選び、「送信開始」を押します（光の点滅に関する注意が出ます）。
4. スマホで「カメラを起動」を押し、送信画面の白い枠がすべて映るように向けます。枠が緑になると、自動で受信が始まります。
5. 受信が終わったら、スマホで「保存」を押します。PC は「停止」を押します。

速さの目安は 1 MiB あたり、送り方「標準」で 12〜25 秒、「速い」で 9〜17 秒、「互換」で 25〜30 秒です（スマホによって変わります）。64 MiB まで送れます。受信を始めるのが途中からでも、途中で画面から外れても、続きから集まります。

## ファイルはサーバに送られません

- ファイルは、画面に表示した模様をカメラで撮影して受け渡します。ファイルの中身がインターネットやサーバを通ることはありません。
- サーバ（GitHub Pages）は、ページ（HTML と JavaScript）を配信するだけです。ファイルの読み込み、模様への変換、撮影した映像からの復元は、すべてお使いの端末のブラウザの中で行います。
- アカウント登録は不要です。このサイトが利用状況や診断情報を送信することはありません。GitHub Pages には、一般的な Web サイトと同じく、ページを開いたときのアクセスの記録が残ることがあります。

## 使う前に知っておいてほしいこと

- **画面が見える人は誰でも受け取れます。** 模様は暗号化していないので、周りから撮影されると内容を取り出されるおそれがあります。人に見られて困るファイルは送らないでください。
- 受け取ったファイルは、送信側で計算したハッシュ値（SHA-256）と一致したときだけ保存できます。壊れたファイルが保存されることはありません。受け取ったファイルが自動で開くこともありません。
- 送信中は画面の模様が毎秒 20 回ほど切り替わります。光の点滅で気分が悪くなったことがある方は使わないでください。見るときは、送信画面の横幅の 2 倍以上離れてください。点滅の基準（WCAG 2.3.1）にはシミュレーションで確認しただけで、専門の解析ツールによる評価は受けていません。

## 動作を確認した環境

- 送る側: Windows の PC と Chrome
- 受け取る側: iPhone（iOS 18 と iOS 16）の Safari。「速い」を縦持ちで受け取れたのは iOS 18 の iPhone だけです（iOS 16 の iPhone は横持ちで）

ほかの端末でも動くことがありますが、確認していません。近くの物にピントが合わないカメラ（一部のタブレットなど）や、処理の遅い端末では受け取れないことがあります。

## 注意

実験的なソフトウェアです。動作や結果は保証しません。

## ライセンス

MIT License（[LICENSE](LICENSE)）

---

# Visual Data Link (English)

A web app that sends a file from a PC screen to a phone camera: the file is shown on the screen as a pattern, and the phone captures it. It runs in the browser only; the file content never travels over the network.

This repository holds the files of the pages published on GitHub Pages.

## How to use

1. On the PC, open the top page of this site and press "Send a file".
2. Scan the QR code on the top page or the send page with the phone's camera to open the receive page.
3. On the PC, choose a file and a mode (Standard, Fast or Compatible) and press "Start sending" (a photosensitivity warning is shown first).
4. On the phone, tap "Start camera" and point it so that the whole white frame of the sending screen is visible. Reception starts by itself when the frame turns green.
5. When it is done, tap "Save" on the phone, and press "Stop" on the PC.

It takes about 12–25 seconds per MiB in mode "Standard", 9–17 s in "Fast" and 25–30 s in "Compatible", depending on the phone, for files up to 64 MiB. Reception can start at any time and continues where it left off if the phone looks away.

## Your file never goes to a server

- The file is passed as patterns on the screen that the camera captures. Its content never travels over the internet or through a server.
- The server (GitHub Pages) only delivers the pages (HTML and JavaScript). Reading the file, turning it into patterns and rebuilding it from the camera images all happen in the browsers on your devices.
- No account is needed. This site sends no usage or diagnostic data. As with any website, GitHub Pages may keep access logs of page visits.

## Before you use it

- **Anyone who can see the screen can receive the file.** The patterns are not encrypted, so someone filming the screen could recover the content. Do not send files that others must not see.
- A received file can be saved only when it matches the sender's hash (SHA-256), so a corrupted file is never saved. Received files are never opened automatically.
- While sending, the pattern changes about 20 times per second. Do not use it if flashing light has ever made you unwell, and watch from at least twice the width of the sending pattern away. The flashing was checked against WCAG 2.3.1 by simulation only, not with a certified analysis tool.

## Tested with

- Sending: Chrome on a Windows PC
- Receiving: Safari on iPhone (iOS 18 and iOS 16). "Fast" was received with the phone held upright only on the iOS 18 iPhone (hold the iOS 16 one sideways)

Other devices may work but are untested. Cameras that cannot focus up close (some tablets) and slow devices may fail to receive.

## Notice

Experimental software, provided without warranty.

## License

MIT License ([LICENSE](LICENSE))
