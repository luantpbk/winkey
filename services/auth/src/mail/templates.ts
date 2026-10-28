import type { MailTemplate, MailLocale } from '../db/types.js';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function renderEmail(
  template: MailTemplate,
  locale: MailLocale,
  params: Record<string, unknown> | null,
): RenderedEmail {
  const link = typeof params?.link === 'string' ? params.link : '';

  switch (template) {
    case 'VERIFY_EMAIL':
      if (locale === 'en') {
        return {
          subject: 'Verify your email address - Winkey',
          text: `Welcome to Winkey!\n\nPlease click the following link to verify your email address:\n${link}\n\nThis link will expire in 48 hours.\nIf you did not create a Winkey account, you can safely ignore this email.`,
          html: `<p>Welcome to Winkey!</p><p>Please click the following link to verify your email address:</p><p><a href="${link}">${link}</a></p><p>This link will expire in 48 hours.</p><p>If you did not create a Winkey account, you can safely ignore this email.</p>`,
        };
      }
      return {
        subject: 'Xác minh địa chỉ email - Winkey',
        text: `Chào mừng bạn đến với Winkey!\n\nVui lòng nhấn vào liên kết sau để xác minh địa chỉ email của bạn:\n${link}\n\nLiên kết này sẽ hết hạn sau 48 giờ.\nNếu bạn không đăng ký tài khoản Winkey, vui lòng bỏ qua email này.`,
        html: `<p>Chào mừng bạn đến với Winkey!</p><p>Vui lòng nhấn vào liên kết sau để xác minh địa chỉ email của bạn:</p><p><a href="${link}">${link}</a></p><p>Liên kết này sẽ hết hạn sau 48 giờ.</p><p>Nếu bạn không đăng ký tài khoản Winkey, vui lòng bỏ qua email này.</p>`,
      };

    case 'RESET_PASSWORD':
      if (locale === 'en') {
        return {
          subject: 'Reset your password - Winkey',
          text: `You requested a password reset for your Winkey account.\n\nPlease click the following link to choose a new password:\n${link}\n\nThis link will expire in 1 hour.\nIf you did not request a password reset, you can safely ignore this email.`,
          html: `<p>You requested a password reset for your Winkey account.</p><p>Please click the following link to choose a new password:</p><p><a href="${link}">${link}</a></p><p>This link will expire in 1 hour.</p><p>If you did not request a password reset, you can safely ignore this email.</p>`,
        };
      }
      return {
        subject: 'Đặt lại mật khẩu - Winkey',
        text: `Bạn đã yêu cầu đặt lại mật khẩu cho tài khoản Winkey.\n\nVui lòng nhấn vào liên kết sau để tạo mật khẩu mới:\n${link}\n\nLiên kết này sẽ hết hạn sau 1 giờ.\nNếu bạn không yêu cầu đặt lại mật khẩu, vui lòng bỏ qua email này.`,
        html: `<p>Bạn đã yêu cầu đặt lại mật khẩu cho tài khoản Winkey.</p><p>Vui lòng nhấn vào liên kết sau để tạo mật khẩu mới:</p><p><a href="${link}">${link}</a></p><p>Liên kết này sẽ hết hạn sau 1 giờ.</p><p>Nếu bạn không yêu cầu đặt lại mật khẩu, vui lòng bỏ qua email này.</p>`,
      };

    case 'PASSWORD_CHANGED':
      if (locale === 'en') {
        return {
          subject: 'Your password was changed - Winkey',
          text: `Your Winkey account password was recently changed.\n\nAll your existing active sessions have been signed out.\nIf you did not make this change, please recover your account immediately or contact support.`,
          html: `<p>Your Winkey account password was recently changed.</p><p>All your existing active sessions have been signed out.</p><p>If you did not make this change, please recover your account immediately or contact support.</p>`,
        };
      }
      return {
        subject: 'Mật khẩu đã được thay đổi - Winkey',
        text: `Mật khẩu tài khoản Winkey của bạn vừa được thay đổi thành công.\n\nMọi phiên đăng nhập hiện tại đã được đăng xuất để bảo đảm an toàn.\nNếu bạn không thực hiện thay đổi này, vui lòng khôi phục tài khoản ngay lập tức hoặc liên hệ hỗ trợ.`,
        html: `<p>Mật khẩu tài khoản Winkey của bạn vừa được thay đổi thành công.</p><p>Mọi phiên đăng nhập hiện tại đã được đăng xuất để bảo đảm an toàn.</p><p>Nếu bạn không thực hiện thay đổi này, vui lòng khôi phục tài khoản ngay lập tức hoặc liên hệ hỗ trợ.</p>`,
      };

    case 'NEW_SIGN_IN': {
      const device = typeof params?.device === 'string' ? params.device : 'Thiết bị';
      const country = typeof params?.country === 'string' ? params.country : '';
      const time = typeof params?.time === 'string' ? params.time : new Date().toISOString();
      if (locale === 'en') {
        return {
          subject: 'New sign-in to your Winkey account',
          text: `A new sign-in was detected on your account.\n\nDevice: ${device}\nLocation: ${country || 'Unknown'}\nTime: ${time}\n\nIf this was not you, please secure your account immediately:\n${link}`,
          html: `<p>A new sign-in was detected on your account.</p><p>Device: ${device}<br/>Location: ${country || 'Unknown'}<br/>Time: ${time}</p><p>If this was not you, please secure your account immediately:<br/><a href="${link}">${link}</a></p>`,
        };
      }
      return {
        subject: 'Đăng nhập mới trên tài khoản Winkey của bạn',
        text: `Phát hiện lượt đăng nhập mới trên tài khoản của bạn.\n\nThiết bị: ${device}\nQuốc gia: ${country || 'Không xác định'}\nThời gian: ${time}\n\nNếu không phải bạn, vui lòng khoá phiên và bảo mật tài khoản ngay lập tức:\n${link}`,
        html: `<p>Phát hiện lượt đăng nhập mới trên tài khoản của bạn.</p><p>Thiết bị: ${device}<br/>Quốc gia: ${country || 'Không xác định'}<br/>Thời gian: ${time}</p><p>Nếu không phải bạn, vui lòng khoá phiên và bảo mật tài khoản ngay lập tức:<br/><a href="${link}">${link}</a></p>`,
      };
    }

    case 'STEP_UP_CODE': {
      const code = typeof params?.code === 'string' ? params.code : '';
      const safeCode = escapeHtml(code);
      if (locale === 'en') {
        return {
          subject: 'Your security verification code - Winkey',
          text: `Your security verification code is: ${code}\n\nThis code will expire in 10 minutes.\nIf this was not you, please change your password immediately.`,
          html: `<p>Your security verification code is: <strong>${safeCode}</strong></p><p>This code will expire in 10 minutes.</p><p>If this was not you, please change your password immediately.</p>`,
        };
      }
      return {
        subject: 'Mã xác thực bảo mật của bạn - Winkey',
        text: `Mã xác thực bảo mật của bạn là: ${code}\n\nMã này sẽ hết hạn sau 10 phút.\nNếu không phải bạn, vui lòng đổi mật khẩu ngay lập tức.`,
        html: `<p>Mã xác thực bảo mật của bạn là: <strong>${safeCode}</strong></p><p>Mã này sẽ hết hạn sau 10 phút.</p><p>Nếu không phải bạn, vui lòng đổi mật khẩu ngay lập tức.</p>`,
      };
    }
  }
}
