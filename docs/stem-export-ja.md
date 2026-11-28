# Pro ToolsでDry・Wetのパラを書き出す

Pro Toolsを動かすMacまたはWindows PCに、一度だけMCPサーバーを登録します。[セットアップ手順](setup.md)

```sh
npm ci
npm run setup -- --client codex --export-only
```

Claude Desktopなら `--client claude`、両方使うなら `--client both` を指定します。登録後は、チャットで「Pro Toolsの接続を診断して」「トラック一覧を出して」「インストはステレオ、Lead Voxはモノ。全トラックを0 dBでDryとWetの両方に書き出して」と依頼できます。Pro Toolsを再起動した場合は次の呼び出しで接続を再登録します。処理途中の書き出しに失敗した場合はエラーを確認して再実行します。

## 書き出し条件

| 項目 | 指定と動作 |
| --- | --- |
| `mode` | `dry`、`wet`、`both`。省略時は `both`。 |
| `fader` | `unity` はトラックフェーダーを0 dB相当として書き出す設定。`current` は現在のレベルと音量オートメーションを反映。省略時は `unity`。 |
| Dry | アクティブなオーディオプレイリストをインサートの手前から取得。Unityでは作業コピーでコンソリデート。Currentでは作業コピーにクリップと音量設定を再インポート。 |
| Wet | 現在有効なインサートを含めてトラック単位で出力。共有リバーブなどのAuxリターンは `fx_returns` で追加すると別のWet WAVになる。 |
| 範囲 | `start_sample` と `end_sample` の組、または空でないタイムライン選択。カーソルだけの場合は対象オーディオトラックのクリップ範囲を使用。残響の余韻を入れる場合はその長さまで選択する。 |
| チャンネル | `dry_channels`、`wet_channels` はトラックごとに1または2。省略時は元トラックの幅。ステレオをモノにするときは左右を等量で合成する。ステレオ化エフェクトを使うボーカルは `wet_channels: 2` を指定し、ステレオ出力できるルーティングを使う。 |
| 出力 | セッション隣の `Bounced Files/Stems-…/Dry` と `Wet`。同一トラック名のWAVを同じ位置に置けば聴き比べられる。48 kHz／24-bit PCM。チャンネル数とサンプル数を検査する。 |

Dryを含む操作では、編集中の内容を失わないよう元のセッションを保存してから作業コピーに切り替えます。処理が終わると元のセッションを開き、選択トラックとタイムライン範囲を復元します。復旧中にユーザーが別のセッションを開いた場合は、そのセッションを閉じずにエラーを返します。

## Track Bounceを使う場合（Pro Tools 2025.6以降）

本体に対応するSDKと、Pro Toolsで保存したプリセットを使います。プリセットにはステム用の形式を設定します（WAV、48 kHz、24-bit PCM、ステレオはInterleaved、フレーム境界へのパディングはオフ）。現在のミックスを聴いたままの仕様と、0 dBでミックスに渡す仕様の2種類を作成できます。

| セットアップ引数 | Pro Toolsで保存する設定 |
| --- | --- |
| `--unity-preset` | Track Bounce。Render Volume Automationをオフ。トラックの幅を保って受け渡す場合はPanのレンダーもオフ。 |
| `--current-preset` | Track Bounce。Render Volume Automationをオン。ミックスのパンも焼き込む場合はPanもオン。 |
| `--dry-import-preset` | Dry/current用の「Track Data to Import」。アクティブなクリップとメディア、クリップゲイン、Main Volume Automation and Settingを含め、プラグイン割り当て・設定、センドを除外する。旧ホストの出力バス方式で使う場合はMain Output Assignmentsも含める。 |

使うプリセットのパスを一度登録します。保存後はチャットでの書き出し指示にパスを含める必要はありません。

```sh
npm run setup -- --client none --unity-preset "/path/to/unity-preset" --current-preset "/path/to/current-preset" --dry-import-preset "/path/to/dry-import-preset"
```

次の例では、ステレオ化エフェクトを通ったボーカルをWetだけステレオで納品します。

```json
{
  "tracks": [
    {"name": "Instrumental", "dry_channels": 2, "wet_channels": 2},
    {"name": "Lead Vox", "dry_channels": 1, "wet_channels": 2}
  ],
  "mode": "both",
  "fader": "unity",
  "fx_returns": ["Vocal Reverb"]
}
```

## Pro Tools 2024.10の専用バス方式

2024.10のSDKでは、Wetに各トラック専用のバスを用意します。セッションテンプレートにルーティングを保存すると繰り返し使えます。Unityには対象トラックからインサート後・プリフェーダーの0 dBセンド、Currentには現在の音量が反映される専用ポストフェーダー経路を使います。各バスにはそのトラックだけを送り、共有リターンやマスター処理が混ざらない経路を指定します。

```json
{
  "tracks": [
    {"name": "Instrumental", "wet_bus": {"unity": "Print Inst Pre"}, "dry_channels": 2, "wet_channels": 2},
    {"name": "Lead Vox", "wet_bus": {"unity": "Print Vox Pre"}, "dry_channels": 1, "wet_channels": 1}
  ],
  "mode": "both",
  "fader": "unity"
}
```

2024.10でDry/currentを使う場合は、各対象トラックのメイン出力を専用バスに割り当て、`dry_current_bus` にそのバス名を指定します。作業コピーで元トラックを非アクティブにしたうえで、インサートを除いたトラックの出力を録ります。Wet/currentとDry/currentで同じ専用メイン出力を使う例です。

```json
{
  "tracks": [{"name":"Lead Vox","wet_bus":{"current":"Print Vox Post"},"dry_current_bus":"Print Vox Post"}],
  "mode": "both",
  "fader": "current"
}
```

## 実機で最初に確かめること

既知の素材を使い、インサートを通したときに音色が明確に変わり、フェーダーが途中で動く短い区間を選びます。元のトラックで一つのインサートをバイパスしておくと、Wetが有効なものだけを通したかも確認できます。Dry/Wetの聴き比べ、UnityとCurrentのレベル差、共有リバーブの分離、元のセッションと選択範囲への復帰を確認します。SDK機能の診断とWAV検査だけではプリセットの音量設定や実際のバス配線は判定できません。
