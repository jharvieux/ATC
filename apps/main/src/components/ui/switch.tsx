import * as React from "react";

export interface SwitchProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  onCheckedChange?: (checked: boolean) => void;
}

const Switch = React.forwardRef<HTMLInputElement, SwitchProps>(
  ({ className = "", checked, onCheckedChange, onChange, ...props }, ref) => {
    function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
      onCheckedChange?.(e.target.checked);
      onChange?.(e);
    }

    return (
      <label className={`relative inline-flex items-center cursor-pointer ${className}`}>
        <input
          ref={ref}
          type="checkbox"
          className="sr-only peer"
          checked={checked}
          onChange={handleChange}
          {...props}
        />
        <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600" />
      </label>
    );
  },
);
Switch.displayName = "Switch";

export { Switch };
