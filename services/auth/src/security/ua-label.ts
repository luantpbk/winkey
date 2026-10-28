import { UAParser } from 'ua-parser-js';

export function buildVietnameseDeviceLabel(userAgent?: string | null): string {
  if (!userAgent || typeof userAgent !== 'string' || userAgent.trim() === '') {
    return 'Thiết bị không xác định';
  }

  const parser = new UAParser(userAgent);
  const res = parser.getResult();

  const browserName = res.browser.name?.trim();
  const osName = res.os.name?.trim();
  const deviceModel = res.device.model?.trim();

  let label: string;

  if (browserName && (deviceModel || osName)) {
    const target = deviceModel || osName;
    label = `${browserName} trên ${target}`;
  } else if (browserName) {
    label = browserName;
  } else if (deviceModel) {
    label = deviceModel;
  } else if (osName) {
    label = `Thiết bị ${osName}`;
  } else {
    label = 'Thiết bị không xác định';
  }

  if (label.length > 80) {
    label = label.slice(0, 77) + '...';
  }

  return label;
}
