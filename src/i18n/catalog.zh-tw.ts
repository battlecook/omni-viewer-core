import { CATALOG_ZH_CN } from './catalog.zh-cn.js';

// Traditional Chinese uses the complete Simplified Chinese catalog as its
// semantic source, then applies Taiwan UI terminology before character
// conversion. This keeps both Chinese catalogs structurally synchronized.
const TAIWAN_TERMS: ReadonlyArray<readonly [string, string]> = [
    ['软件包', '套件'], ['演示文稿', '簡報'], ['幻灯片', '投影片'],
    ['电子表格', '試算表'], ['工作簿', '活頁簿'], ['工作表', '工作表'],
    ['单元格', '儲存格'], ['源代码', '原始碼'], ['压缩包', '壓縮檔'],
    ['剪贴板', '剪貼簿'], ['文件大小', '檔案大小'], ['原文件', '原始檔案'],
    ['文件内容', '檔案內容'], ['选择文件', '選擇檔案'], ['保存文件', '儲存檔案'],
    ['文件类型', '檔案類型'], ['此文件', '此檔案'], ['新文件', '新檔案'],
    ['文件格式', '檔案格式'], ['完整文件', '完整檔案'], ['文件', '檔案'],
    ['保存', '儲存'], ['加载', '載入'], ['打印', '列印'], ['查看器', '檢視器'],
    ['视频', '影片'], ['图像', '影像'], ['源文本', '原始文字'], ['纯文本', '純文字'],
    ['十六进制', '十六進位'], ['字节', '位元組'], ['制表符', '定位字元'],
    ['另存为', '另存新檔'], ['设置', '設定'], ['链接', '連結'],
    ['条目', '項目'], ['高亮', '醒目提示'], ['下划线', '底線'],
    ['删除线', '刪除線'], ['批注', '註解'], ['精灵图', 'Sprite 圖'],
    ['自动检测', '自動偵測'], ['检测', '偵測'], ['重置', '重設'],
    ['适应窗口', '符合視窗'], ['匹配主题颜色', '符合主題色彩'],
    ['空闲', '閒置'], ['就绪', '就緒'], ['回退功能', '備援功能'],
    ['元数据', '中繼資料'], ['数据库', '資料庫'], ['数据', '資料'],
    ['文件夹', '資料夾'], ['目录', '目錄'], ['路径', '路徑'],
    ['屏幕', '螢幕'], ['网络', '網路'], ['信息', '資訊']
];

const TRADITIONAL_CHARS: Readonly<Record<string, string>> = {
    "font.fallback": "此字型未包含的字元會使用替代字型顯示。",
    "font.title": "字型",
    "font.format": "格式",
    "font.family": "字型家族",
    "font.style": "樣式",
    "font.postScriptName": "PostScript 名稱",
    "font.version": "版本",
    "font.glyphCount": "字形數",
    "font.unitsPerEm": "每 em 單位數",
    "font.weight": "字重",
    "font.copyright": "版權",
    "font.license": "授權",
    "font.sample": "範例文字",
    "font.defaultSample": "天地玄黃，宇宙洪荒。\nThe quick brown fox jumps over the lazy dog.\nABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789",
    "font.size": "字級",
    "font.characters": "字元列表",
    "font.search": "搜尋字元或 Unicode (U+0041)",
    "font.previous": "上一頁",
    "font.next": "下一頁",
    "font.page": "第 {page} / {pages} 頁 · {count} 個字元",
    "font.glyph": "{code} · 字形 {index}",
    "font.empty": "沒有符合的字元。",
    "font.unavailable": "無法繪製字型。顯示字型中繼資料。",
    "diag.font.invalid": "不支援的字型格式。請使用 TTF、OTF 或 WOFF。",
    "diag.font.corrupted": "字型資料不完整或已損毀。",
    "diag.font.limit": "字型解析超出資源限制。",
    "diag.font.decompression": "讀取壓縮的 WOFF 表需要支援 DecompressionStream。",
    "diag.font.cmap": "沒有支援的字元對應表。",
    "diag.font.preview": "字元預覽已達上限。搜尋僅適用於預覽字元。",

    '频':'頻','暂':'暫','选':'選','区':'區','缩':'縮','视':'視','图':'圖','谱':'譜','时':'時','长':'長',
    '声':'聲','码':'碼','浏':'瀏','览':'覽','无':'無','编':'編','请':'請','转':'轉','换':'換','过':'過',
    '数':'數','库':'庫','志':'誌','获':'獲','属':'屬','击':'擊','记':'記','录':'錄','读':'讀','标':'標',
    '压':'壓','变':'變','结':'結','条':'條','务':'務','软':'軟','举':'舉','关':'關','系':'係','谁':'誰',
    '导':'導','贴':'貼','检':'檢','删':'刪','号':'號','类':'類','载':'載','复':'複','单':'單','测':'測',
    '动':'動','调':'調','双':'雙','显':'顯','旧':'舊','页':'頁','续':'續','汇':'彙','绪':'緒','毁':'毀',
    '档':'檔','筛':'篩','径':'徑','间':'間','见':'見','择':'擇','纯':'純','内':'內','储':'儲','键':'鍵',
    '节':'節','点':'點','组':'組','闭':'閉','达':'達','别':'別','电':'電','拟':'擬','竖':'豎','统':'統',
    '计':'計','称':'稱','叠':'疊','验':'驗','输':'輸','宽':'寬','题':'題','颜':'顏','并':'併','签':'簽',
    '划':'劃','线':'線','释':'釋','滤':'濾','镜':'鏡','画':'畫','帧':'幀','挡':'擋','灵':'靈','这':'這',
    '为':'為','仅':'僅','与':'與','将':'將','从':'從','个':'個','开':'開','该':'該','当':'當','对':'對',
    '应':'應','给':'給','处':'處','块':'塊','层':'層','亿':'億','万':'萬','还':'還','进':'進','终':'終',
    '确':'確','误':'誤','损':'損','坏':'壞','异':'異','余':'餘','额':'額','满':'滿','边':'邊','义':'義',
    '实':'實','现':'現','术':'術','问':'問','启':'啟','简':'簡','体':'體','冲':'衝','构':'構','备':'備',
    '隐':'隱','递':'遞','归':'歸','陈':'陳','语':'語','历':'歷','权':'權','级':'級','网':'網','报':'報',
    '错':'錯','锁':'鎖','写':'寫','临':'臨','鉴':'鑑','纸':'紙','顺':'順','布':'佈','离':'離',
    '发':'發','华':'華','广':'廣','后':'後','里':'裡','种':'種','项':'項','传':'傳','优':'優','栏':'欄',
    '设':'設','试':'試','词':'詞','会':'會','虑':'慮','拥':'擁','险':'險'
};

function toTraditionalTaiwan(value: string): string {
    let localized = value;
    for (const [source, replacement] of TAIWAN_TERMS) localized = localized.split(source).join(replacement);
    return Array.from(localized, (char) => TRADITIONAL_CHARS[char] ?? char).join('');
}

export const CATALOG_ZH_TW: Record<string, string> = Object.fromEntries(
    Object.entries(CATALOG_ZH_CN).map(([key, value]) => [key, toTraditionalTaiwan(value)])
);

Object.assign(CATALOG_ZH_TW, {
    "geojson.title": "GeoJSON",
    "geojson.propertiesTruncated": "部分屬性超過預覽限制而被省略。",
    "geojson.summary": "{features} 個圖徵 · {vertices} 個頂點 · WGS84",
    "geojson.features": "圖徵",
    "geojson.feature": "圖徵 {id}",
    "geojson.map": "GeoJSON 地圖",
    "geojson.hint": "捲動縮放，拖曳平移。鍵盤：+/− 縮放，方向鍵平移，0 顯示全圖。",
    "geojson.empty": "沒有可顯示的幾何圖形。",
    "geojson.properties": "屬性",
    "geojson.noSelection": "選擇圖徵",
    "geojson.noProperties": "此圖徵沒有屬性。",
    "geojson.zoomIn": "放大",
    "geojson.zoomOut": "縮小",
    "geojson.reset": "顯示全圖",
    "diag.geojson.invalid": "無效的 GeoJSON 文件。",
    "diag.geojson.geometry": "圖徵 {index} 的幾何圖形或中繼資料無效，已略過。",
    "diag.geojson.limit": "GeoJSON 預覽已達資源限制，部分圖徵可能被省略。",
    "diag.geojson.crs": "不套用舊版 CRS 中繼資料。座標以 WGS84 經度和緯度解讀。",
});

Object.assign(CATALOG_ZH_TW, {
    "arrow.title": "Arrow / Feather V2",
    "arrow.summary": "{rows} 列 · {columns} 欄 · {batches} 個記錄批次",
    "arrow.search": "搜尋預覽列",
    "arrow.table": "表格",
    "arrow.schema": "結構描述",
    "arrow.raw": "JSON",
    "arrow.copyTable": "複製表格",
    "arrow.copyJson": "複製 JSON",
    "arrow.exportJson": "匯出 JSON",
    "arrow.pageSize": "每頁列數",
    "arrow.matches": "預覽 {loaded} 列中的 {matched} 列",
    "arrow.empty": "沒有可預覽的列。",
    "arrow.noMatches": "沒有符合的列。",
    "arrow.actionFailed": "操作失敗，請重試。",
    "diag.arrow.invalid": "無效的 Arrow IPC 檔案或串流。",
    "diag.arrow.corrupted": "Arrow IPC 資料已截斷或損毀。",
    "diag.arrow.featherV1": "不支援 Feather V1。請另存為 Feather V2（Arrow IPC）。",
    "diag.arrow.dependency": "請安裝選用相依套件 apache-arrow 以讀取 Arrow IPC 檔案。",
    "diag.arrow.compression": "壓縮的 Arrow IPC 需要 LZ4/ZSTD 解碼器。請安裝 lz4js 和 fzstd，或注入解碼器。",
    "diag.arrow.limit": "Arrow IPC 解析超出了資源限制。",
    "diag.arrow.preview": "在預覽限制內顯示 {total} 列中的 {loaded} 列。搜尋、複製與匯出僅適用於這些預覽列。",
});
