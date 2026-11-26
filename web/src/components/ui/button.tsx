import type * as React from 'react';
import { cn } from '@/lib/utils';

const BASE =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0';

const VARIANTS = {
  default:
    'bg-nav-active text-white shadow-sm hover:bg-nav-active/90 hover:shadow-md active:translate-y-px',
  secondary: 'border border-nav-active/40 bg-transparent text-nav-active hover:bg-nav-active/10',
  destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
  ghost: 'text-slate hover:bg-accent hover:text-accent-foreground',
  link: 'text-link underline-offset-4 hover:underline',
} as const;

const SIZES = {
  default: 'h-9 px-3.5 py-2',
  sm: 'h-8 rounded-md px-3 text-[13px]',
  lg: 'h-10 rounded-md px-5',
} as const;

export type ButtonVariant = keyof typeof VARIANTS;
export type ButtonSize = keyof typeof SIZES;

export function buttonVariants({
  variant = 'default',
  size = 'default',
}: { variant?: ButtonVariant; size?: ButtonSize } = {}): string {
  return cn(BASE, VARIANTS[variant], SIZES[size]);
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
