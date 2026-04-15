import { forwardRef } from 'react';

type Props = React.HTMLAttributes<HTMLDivElement> & {
  tone?: 'default' | 'raised' | 'ghost' | 'accent';
  padding?: 'sm' | 'md' | 'lg';
};

const toneCls = {
  default: 'bg-panel border border-border',
  raised:  'bg-panel-2 border border-border-strong',
  ghost:   'bg-transparent border border-border',
  accent:  'bg-accent-soft border border-accent/30',
};
const padCls = { sm: 'p-3', md: 'p-4', lg: 'p-5' };

export const Card = forwardRef<HTMLDivElement, Props>(function Card(
  { tone = 'default', padding = 'md', className = '', children, ...rest }, ref
) {
  return (
    <div
      ref={ref}
      className={`rounded-xl shadow-card ${toneCls[tone]} ${padCls[padding]} ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
});
