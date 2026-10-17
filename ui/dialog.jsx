import React from 'react';
import { Modal as MantineModal, Stack } from '@mantine/core';
export default function Modal({ title, children, onClose }) {
  return (
    <MantineModal
      opened
      onClose={onClose}
      title={title}
      centered
      closeOnClickOutside={false}
      padding="xl"
      radius="lg"
    >
      <Stack gap="lg">{children}</Stack>
    </MantineModal>
  );
}
