import { formatLocalNow } from './utils.js';

export function prepareMessageStreamText(options: {
  text: string;
  originalImageCount: number;
  validImageCount: number;
  maxImageDimension: number;
  decorateText?: (text: string) => string;
  now?: Date;
}): string {
  let effectiveText = options.text;
  if (
    options.originalImageCount > 0 &&
    options.validImageCount === 0 &&
    !effectiveText.trim()
  ) {
    effectiveText = `[用户发送了 ${options.originalImageCount} 张图片，但因尺寸超出 API 限制（最大 ${options.maxImageDimension}px）被跳过。请提示用户压缩或截取后重发。]`;
  }
  if (options.decorateText) {
    effectiveText = options.decorateText(effectiveText);
  }
  return `[当前时间: ${formatLocalNow(options.now)}]\n${effectiveText}`;
}
