import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const service = vi.hoisted(() => ({
  enable: vi.fn(),
  unlock: vi.fn(),
  restore: vi.fn(),
  uploadPending: vi.fn(async () => 0),
}));
vi.mock('../src/lib/e2ee/key-backup-service', () => ({ getKeyBackupService: () => service }));

import { BackupRestoreDialog, BackupSetupDialog } from '../src/components/chat/key-backup-dialogs';
import { BackupError } from '../src/lib/e2ee/key-backup';

describe('SOC-3b key backup dialogs', () => {
  beforeEach(() => {
    for (const fn of Object.values(service)) fn.mockReset();
    service.uploadPending.mockResolvedValue(0);
  });

  it('turns on only after the generated passphrase is typed back and the user confirms saving it', async () => {
    service.enable.mockResolvedValue({ version: 1 });
    const onDone = vi.fn();
    render(<BackupSetupDialog mode="enable" onClose={() => {}} onDone={onDone} />);
    const phrase = screen.getByTestId('generated-passphrase').textContent!;
    expect(phrase.split(' ')).toHaveLength(5);

    const submit = screen.getByRole('button', { name: 'Bật sao lưu' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Nhập lại cụm mật khẩu để xác nhận'), {
      target: { value: 'sai' },
    });
    fireEvent.click(screen.getByLabelText(/Tôi đã lưu cụm mật khẩu/));
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Nhập lại cụm mật khẩu để xác nhận'), {
      target: { value: phrase },
    });
    expect(submit.disabled).toBe(false);

    fireEvent.click(submit);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(service.enable).toHaveBeenCalledWith(phrase, { replace: false });
  });

  it('warns before a reset and replaces the backup', async () => {
    service.enable.mockResolvedValue({ version: 2 });
    render(<BackupSetupDialog mode="reset" onClose={() => {}} onDone={() => {}} />);
    expect(screen.getByRole('alert').textContent).toMatch(/mất\s+vĩnh viễn/);
    const phrase = screen.getByTestId('generated-passphrase').textContent!;
    fireEvent.change(screen.getByLabelText('Nhập lại cụm mật khẩu để xác nhận'), {
      target: { value: phrase },
    });
    fireEvent.click(screen.getByLabelText(/Tôi đã lưu cụm mật khẩu/));
    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    await waitFor(() => expect(service.enable).toHaveBeenCalledWith(phrase, { replace: true }));
  });

  it('shows a clear error for a wrong passphrase, then restores', async () => {
    service.unlock.mockRejectedValueOnce(
      new BackupError('Cụm mật khẩu khôi phục không đúng.', 'WRONG_PASSPHRASE'),
    );
    const onRestored = vi.fn();
    render(<BackupRestoreDialog onClose={() => {}} onRestored={onRestored} />);
    const input = screen.getByLabelText('Cụm mật khẩu khôi phục');
    fireEvent.change(input, { target: { value: 'sai rồi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Khôi phục' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Cụm mật khẩu khôi phục không đúng.',
    );
    expect(onRestored).not.toHaveBeenCalled();

    service.unlock.mockResolvedValueOnce({ version: 1 });
    service.restore.mockImplementation(async (progress: (d: number, t: number) => void) => {
      progress(3, 3);
      return { imported: 3, kept: 0, failed: 0 };
    });
    fireEvent.change(input, { target: { value: 'đúng rồi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Khôi phục' }));
    await waitFor(() => expect(onRestored).toHaveBeenCalled());
    expect(service.unlock).toHaveBeenLastCalledWith('đúng rồi');
  });
});
