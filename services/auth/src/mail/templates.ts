import type { MailTemplate, MailLocale } from '../db/types.js';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
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
  }
}
