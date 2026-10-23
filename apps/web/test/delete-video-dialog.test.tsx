import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { DeleteVideoDialog } from '../src/components/admin/delete-video-dialog';

describe('DeleteVideoDialog confirmation word', () => {
  const setup = () => {
    render(<DeleteVideoDialog isOpen videoTitle="Tập 1" onClose={vi.fn()} onConfirm={vi.fn()} />);
    return {
      input: screen.getByTestId('confirm-delete-input'),
      submit: screen.getByTestId('confirm-delete-submit-btn') as HTMLButtonElement,
    };
  };

  it('shows "XÓA" as the word to type', () => {
    setup();
    expect(screen.getByText('XÓA')).toBeDefined();
    expect(screen.queryByText('XOÁ')).toBeNull();
  });

  it.each(['XÓA', 'xóa', ' Xóa ', 'XOÁ', 'xoá'])('accepts %j', (typed) => {
    const { input, submit } = setup();
    fireEvent.change(input, { target: { value: typed } });
    expect(submit.disabled).toBe(false);
  });

  it.each(['', 'XOA', 'DELETE', 'XÓA video'])('rejects %j', (typed) => {
    const { input, submit } = setup();
    fireEvent.change(input, { target: { value: typed } });
    expect(submit.disabled).toBe(true);
  });
});
