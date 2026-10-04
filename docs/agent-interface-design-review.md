# 観測・操作の設計契約

公開 API の契約は [Minecraft reference](../skills/minecraft/references/playbooks.md) に集約する。

| 層 | 責務 |
|---|---|
| Mineflayer / adapter | 取得した値の解釈と正規化。未取得値を既知として扱わない |
| track / lifecycle | 個体の同一性、確認済み binding、world epoch |
| ActionManager | resource ownership、状態確定、終了時点の結果、bounded history |
| EventStore | 一過性イベント、replay、gap |
| frame / query projection | 公開値、未知・空・省略、表示量 |
| delta | 公開観測の差分転送 |

- 高頻度の移動は現在状態へ反映し、各 packet を semantic event として保持しない。
- 未取得の絶対位置を constructor の既定値や relative movement から補わない。
- 同じ binding の追加情報は track に反映する。確認済み UUID の変更は旧 binding を失効させ、衝突は他の active binding を奪わない。
- 操作と非同期継続は現在の binding / epoch / ownership を再検証する。context は frame 全体の鮮度を保証しない。
- frame と一点 query は値の意味と解決規則を共有する。別の現在状態を所有しない。
- navigation の成功 predicate と公開する判定距離は同じ位置・node・goal から求める。結果は終了時点で固定する。
- 履歴の保持は ActionManager / EventStore、表示の選別は observation の責務。frame 読取は結果を消費しない。
- delta を baseline に適用した結果は同じ projection の full frame と一致する。
