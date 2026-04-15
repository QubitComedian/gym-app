import { forwardRef } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
};

const variantCls: Record<Variant, string> = {
  primary:   'bg-accent text-black font-semibold hover:brightness-95 active:brightness-90',
  secondary: 'bg-panel-2 border border-border text-white hover:bg-panel-2/80',
  ghost:     'bg-transparent text-muted hover:text-white',
  danger:    'bg-danger/15 text-danger border border-danger/30',
};
const sizeCls: Record<Size, string> = {
  sm: 'px-3 py-1.5 text-tiny rounded',
  md: 'px-4 py-2.5 text-small rounded-lg',
  lg: 'px-5 py-3.5 text-base rounded-xl',
};

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = 'secondary', size = 'md', className = '', children, ...rest }, ref
) {
  return (
    <button
      ref={ref}
      className={`inline-flex items-center justify-center gap-1.5 transition-colors disabled:opacity-50 disabled:pointer-events-none ${variantCls[variant]} ${sizeCls[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
});
