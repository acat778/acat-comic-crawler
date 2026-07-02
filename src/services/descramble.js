/**
 * JMComic (禁漫天堂) 图片去混淆模块
 *
 * 算法参考：
 *   - hect0x7/JMComic-Crawler-Python (JmImageTool.decode_and_save)
 *   - TunaFish2K/jmcomic-web-client
 *
 * JMComic 的图片混淆方式：
 *   将原始图片水平切割成若干段（竖条），颠倒排列顺序。
 *   还原时根据图片所属 photo/chapter ID 计算出段数和切分位置，从底部向上读取、从顶部向下重新拼接。
 *
 * 版本演进：
 *   - imageId < scrambleId：无混淆
 *   - scrambleId ≤ imageId < 268850：固定 10 段
 *   - 268850 ≤ imageId < 421926：基于 MD5 哈希，x=10，段数 ∈ [2, 20]
 *   - imageId ≥ 421926：基于 MD5 哈希，x=8，段数 ∈ [2, 16]
 */

import crypto from 'crypto';
import sharp from 'sharp';

// region 常量（来自 JmMagicConstants）

const SCRAMBLE_220980 = 220980;
const SCRAMBLE_268850 = 268850;
const SCRAMBLE_421926 = 421926;

export const DEFAULT_SCRAMBLE_ID = SCRAMBLE_220980;

// endregion

// region 段数计算

/**
 * 计算去混淆所需的段数。
 *
 * @param {object} params
 * @param {number|string} params.scrambleId - JMComic 页面返回的 scramble_id
 * @param {number|string} params.imageId    - 图片所属 photo/chapter ID
 * @param {string} params.filename          - 图片文件名（如 "00001.jpg"）
 * @returns {number} 段数，0 表示无需去混淆
 */
export function getSegmentCount({ scrambleId = DEFAULT_SCRAMBLE_ID, imageId, filename }) {
  const sid = typeof scrambleId === 'string' ? parseInt(scrambleId, 10) : scrambleId;
  const aid = typeof imageId === 'string' ? parseInt(imageId, 10) : imageId;

  if (isNaN(sid) || isNaN(aid) || aid < sid) {
    return 0; // 无需去混淆
  }

  if (aid < SCRAMBLE_268850) {
    return 10; // V1：固定 10 段
  }

  // V2 / V3：基于 MD5 哈希的段数计算
  const x = aid < SCRAMBLE_421926 ? 10 : 8; // V2: x=10, V3: x=8
  const hash = crypto.createHash('md5').update(`${aid}${filename}`, 'utf8').digest('hex');
  const lastCharCode = hash.charCodeAt(hash.length - 1);
  const num = (lastCharCode % x) * 2 + 2;

  return num;
}

// endregion

// region 去混淆核心

/**
 * 对 JMComic 混淆图片执行去混淆。
 *
 * 算法说明（来自 JmImageTool.decode_and_save）：
 *   move  = floor(h / num)        — 每段基本高度
 *   over  = h % num               — 余数像素（由原图顶部段承载）
 *   对 i ∈ [0, num)：
 *     y_src = h - (move * (i + 1)) - over   ← 从混淆图底部向上读取
 *     y_dst = move * i                       ← 向输出图顶部向下写入
 *     若 i == 0：段高 = move + over，不加偏移
 *     若 i > 0 ：段高 = move，y_dst += over（跳过顶部余数段）
 *
 * @param {Buffer}  imageBuffer  - 原始混淆图片的二进制数据
 * @param {object}  params       - 去混淆参数
 * @param {number|string} params.scrambleId - JMComic 页面返回的 scramble_id
 * @param {number|string} params.imageId    - 图片所属 photo/chapter ID
 * @param {string}  params.filename         - 图片文件名
 * @param {object}  [options]    - 可选配置
 * @param {string}  [options.format] - 输出格式 (jpeg/png/webp)，默认 jpeg
 * @param {number}  [options.quality] - 输出质量 1-100，默认 95
 * @returns {Promise<Buffer>} 去混淆后的图片二进制数据
 */
export async function descramble(imageBuffer, params = {}) {
  const num = getSegmentCount(params);

  if (num === 0) {
    // 无需去混淆，直接返回原图
    return imageBuffer;
  }

  const { format = 'jpeg', quality = 95 } = params;

  // 1. 解码为原始 RGBA 像素
  const { data, info } = await sharp(imageBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info; // channels = 4

  // 2. 计算段参数
  const move = Math.floor(height / num);
  const over = height % num;
  const rowSize = width * channels;

  // 3. 逐段复制：从混淆图底部向上读取 → 输出图顶部向下写入
  const output = Buffer.alloc(data.length);

  for (let i = 0; i < num; i++) {
    const ySrc = height - move * (i + 1) - over;
    let yDst = move * i;
    let segHeight = move;

    if (i === 0) {
      // 第一段（原图顶部段）：包含余数
      segHeight = move + over;
    } else {
      // 后续段：跳过余数段在输出中的位置
      yDst += over;
    }

    const srcStart = ySrc * rowSize;
    const srcEnd = srcStart + segHeight * rowSize;
    const dstStart = yDst * rowSize;

    data.copy(output, dstStart, srcStart, srcEnd);
  }

  // 4. 编码回图片格式
  const outputOptions = { raw: { width, height, channels } };

  switch (format) {
    case 'png':
      return sharp(output, outputOptions).png({ quality }).toBuffer();
    case 'webp':
      return sharp(output, outputOptions).webp({ quality }).toBuffer();
    case 'jpeg':
    default:
      return sharp(output, outputOptions).jpeg({ quality }).toBuffer();
  }
}

// endregion

// region 便捷方法：从文件路径去混淆

import fs from 'fs';

/**
 * 读取混淆图片文件，去混淆后写回（覆盖或另存）。
 *
 * @param {string}  inputPath   - 混淆图片文件路径
 * @param {string}  outputPath  - 输出路径
 * @param {object}  params      - 同 descramble()
 * @returns {Promise<number>} 写入文件的字节数
 */
export async function descrambleFile(inputPath, outputPath, params = {}) {
  const inputBuffer = fs.readFileSync(inputPath);
  const outputBuffer = await descramble(inputBuffer, params);

  // 如果输出路径与输入相同则覆盖
  fs.writeFileSync(outputPath, outputBuffer);
  return outputBuffer.length;
}

// endregion
