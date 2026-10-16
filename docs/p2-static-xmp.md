# P2 普通静态 XMP 误拦截修复

日期：2026-10-16。

## 真实样本结论

用户提供的 IMG_0096.PNG 为 682,722 字节、828×1792。其未压缩 PNG iTXt XMP 只含 exif:UserComment（截图说明）和 photoshop:DateCreated。此前遇到任何 XMP 都拒绝，导致普通静态图误拦截。该结论只针对提供的样本，不由扩展名或截图说明推断所有文件来源。

样本留在 Git 忽略的 tests/private-fixtures/xmp/ 中。仓库只包含自行构造的结构等价样本，不复制原图、原始日期或文件内唯一标识。

## 本轮放行范围

采用固定版本 saxes 6.0.0 做 XML 命名空间解析（[项目说明](https://github.com/lddubeau/saxes)）。支持 UTF-8、最多 32 KiB、最多 32 个元素的 xmpmeta → RDF → 单个 Description → 文本字段结构。只允许以下字段及工具描述、空 RDF subject：

- http://ns.adobe.com/exif/1.0/ 下的 UserComment。
- http://ns.adobe.com/photoshop/1.0/ 下的 DateCreated。

按命名空间 URI 与局部名称判断，不依赖 exif 等前缀。两个字段支持元素或 Description 属性形式；文本只是描述数据，不执行内容。PNG 未压缩 iTXt/tEXt 和 JPEG 标准 XMP APP1 使用同一规则，原图字节完全保留。

未知命名空间或字段（包括动态照片关联）、重复字段/块、嵌套复杂结构、DTD、处理指令、非法实体/UTF-8、超限 XML 均拒绝。压缩 PNG XMP、JPEG 扩展 XMP 和未知 APP1 仍拒绝，不解压、不加载外部实体。保留保守策略，因此其他普通软件生成的不同 XMP 仍可能被拒绝，需要逐类评估；不能据此声称已支持全部 XMP。

Apple EXIF 配对标签及已登记设备资产关联拦截继续执行。安全 XMP 与 Live Photo EXIF 同时存在时仍拒绝。认证、密码和 reset/ACK 没有修改，CPU 超预算继续暂缓。元数据被移除等既有不可识别边界依然存在。

## 验证方法

新增回归覆盖安全字段、前缀别名、属性形式、XML 字符引用、原图字节/Sync/ACK；拒绝未知动态字段、命名空间欺骗、DTD/实体、嵌套/损坏/超大 XML、重复 XMP、压缩 XMP及安全 XMP 叠加 Apple 配对标签，并检查拒绝后无资产/上传意图/R2 对象。

本机样本用例在文件存在时执行上传、去重、828×1792 同步尺寸及原图字节检查；无私有样本的其他环境明确 skip，不能把 skip 当作真实样本验证通过。公网脚本 node scripts/xmp-probe.mjs 默认用合成图；加 --private 会额外把用户指定的私有样本上传到 dev，验证后保留在该测试账户中，不写入 Git。
