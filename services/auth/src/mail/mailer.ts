import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { Env } from '../config/env.js';
import type { RenderedEmail } from './templates.js';

export interface MailerLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface MailSender {
  sendMail(options: {
    queueId: string;
    toEmail: string;
    template: string;
    rendered: RenderedEmail;
  }): Promise<void>;
  close(): Promise<void>;
}

export class NodeMailerSender implements MailSender {
  private transporter: Transporter | null = null;
  private readonly transportType: 'smtp' | 'log';
  private readonly mailFrom: string;
  private readonly logger?: MailerLogger;

  constructor(env: Env, logger?: MailerLogger) {
    this.transportType = env.MAIL_TRANSPORT;
    this.mailFrom = env.MAIL_FROM;
    this.logger = logger;

    if (this.transportType === 'smtp' && env.SMTP_URL) {
      this.transporter = nodemailer.createTransport(env.SMTP_URL);
    }
  }

  async sendMail(options: {
    queueId: string;
    toEmail: string;
    template: string;
    rendered: RenderedEmail;
  }): Promise<void> {
    const { queueId, toEmail, template, rendered } = options;

    if (this.transportType === 'log' || !this.transporter) {
      // In log mode, suppress sending and log safe telemetry (no email, no token/link)
      this.logger?.info({ queueId, template, op: 'mail_suppressed' }, 'mail suppressed');
      return;
    }

    await this.transporter.sendMail({
      from: this.mailFrom,
      to: toEmail,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
  }

  async close(): Promise<void> {
    if (this.transporter) {
      this.transporter.close();
    }
  }
}
