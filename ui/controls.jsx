import React, { Children, isValidElement } from 'react';
import {
  ActionIcon,
  Button as MantineButton,
  Select,
  NumberInput,
  UnstyledButton,
  Accordion,
  Stack,
} from '@mantine/core';

// Keep button intent consistent across list actions, forms and full-page wizards.
export function Button({ className = '', type = 'button', children, ...props }) {
  if (className.includes('icon-button'))
    return (
      <ActionIcon className={className} variant="subtle" size="lg" type={type} {...props}>
        {children}
      </ActionIcon>
    );
  if (className.includes('route-info') || className.includes('type-choice'))
    return (
      <UnstyledButton className={className} type={type} {...props}>
        {children}
      </UnstyledButton>
    );
  const variant = className.includes('primary')
    ? 'filled'
    : className.includes('secondary')
      ? 'default'
      : props['aria-pressed'] || props['aria-current']
        ? 'light'
        : 'subtle';
  return (
    <MantineButton
      type={type}
      variant={variant}
      className={className}
      size={className.includes('small') ? 'xs' : 'sm'}
      fullWidth={className.includes('full')}
      {...props}
    >
      {children}
    </MantineButton>
  );
}

const text = (node) =>
  Children.toArray(node)
    .map((child) => (isValidElement(child) ? text(child.props.children) : String(child)))
    .join('');
export function SelectField({ children, onChange, value, ...props }) {
  const data = Children.toArray(children)
    .filter(isValidElement)
    .map((option) => ({
      value: String(option.props.value ?? text(option.props.children)),
      label: text(option.props.children),
      disabled: option.props.disabled,
    }));
  return (
    <Select
      {...props}
      data={data}
      value={String(value ?? '')}
      allowDeselect={false}
      searchable={data.length > 8}
      nothingFoundMessage="No matches"
      maxDropdownHeight={280}
      onChange={(next) => onChange?.({ target: { value: next ?? '' } })}
    />
  );
}

export function NumberField({ onChange, ...props }) {
  return (
    <NumberInput
      {...props}
      allowDecimal={false}
      onChange={(value) => onChange?.({ target: { value } })}
    />
  );
}

export function Disclosure({ title, defaultOpen, children, ...props }) {
  return (
    <Accordion variant="separated" defaultValue={defaultOpen ? 'options' : null} {...props}>
      <Accordion.Item value="options">
        <Accordion.Control>{title}</Accordion.Control>
        <Accordion.Panel>
          <Stack gap="md">{children}</Stack>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}
