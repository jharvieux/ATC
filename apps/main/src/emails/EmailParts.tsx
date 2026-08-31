import * as React from "react";

export const DEFAULT_PRIMARY = "#1f2937";
export const DEFAULT_ACCENT = "#3b82f6";

export function SectionHeading(props: { accent: string; children: React.ReactNode }): React.ReactElement {
  return (
    <table role="presentation" width="100%" cellSpacing={0} cellPadding={0} style={{ margin: "32px 0 12px 0" }}>
      <tbody>
        <tr>
          <td width={30} style={{ padding: "0 10px 0 0", verticalAlign: "middle" }}>
            <table role="presentation" width="100%" cellSpacing={0} cellPadding={0}>
              <tbody>
                <tr>
                  <td style={{ height: 3, backgroundColor: props.accent, fontSize: 1, lineHeight: "1px" }}>&nbsp;</td>
                </tr>
              </tbody>
            </table>
          </td>
          <td style={{ verticalAlign: "middle" }}>
            <h3 style={{ margin: 0, color: "#243447", fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 20, fontWeight: 700, lineHeight: 1.25 }}>
              {props.children}
            </h3>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

export function CtaButton(props: { href: string; accent: string; children: React.ReactNode }): React.ReactElement {
  return (
    <table role="presentation" width="100%" cellSpacing={0} cellPadding={0} style={{ margin: "30px 0 8px 0" }}>
      <tbody>
        <tr>
          <td align="center">
            <table role="presentation" cellSpacing={0} cellPadding={0}>
              <tbody>
                <tr>
                  <td style={{ backgroundColor: props.accent, borderRadius: 4 }}>
                    <a
                      href={props.href}
                      style={{
                        display: "inline-block",
                        padding: "14px 26px",
                        color: "#ffffff",
                        textDecoration: "none",
                        fontWeight: 700,
                        fontSize: 14,
                        letterSpacing: 0.2,
                      }}
                    >
                      {props.children}
                    </a>
                  </td>
                </tr>
              </tbody>
            </table>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

export function CountdownBadge(props: { accent: string; children: React.ReactNode }): React.ReactElement {
  return (
    <table role="presentation" width="100%" cellSpacing={0} cellPadding={0} style={{ margin: "0 0 14px 0" }}>
      <tbody>
        <tr>
          <td align="center">
            <table role="presentation" cellSpacing={0} cellPadding={0}>
              <tbody>
                <tr>
                  <td style={{ padding: "6px 12px", backgroundColor: "#f7fafc", border: `1px solid ${props.accent}`, borderRadius: 3, color: props.accent, fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase" }}>
                    {props.children}
                  </td>
                </tr>
              </tbody>
            </table>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

export function ChecklistCard(props: { items: string[]; accent: string }): React.ReactElement | null {
  if (props.items.length === 0) return null;
  return (
    <table
      role="presentation"
      width="100%"
      cellSpacing={0}
      cellPadding={0}
      style={{ backgroundColor: "#f7fafc", border: "1px solid #e2e8f0", borderRadius: 4 }}
    >
      <tbody>
        {props.items.map((item, index) => (
          <tr key={`${item}-${index}`}>
            <td
              width={42}
              style={{
                padding: index === 0 ? "15px 0 9px 16px" : "9px 0 9px 16px",
                color: props.accent,
                fontFamily: "Georgia, 'Times New Roman', serif",
                fontSize: 18,
                fontWeight: 700,
                lineHeight: 1.4,
                verticalAlign: "top",
              }}
            >
              {String(index + 1).padStart(2, "0")}
            </td>
            <td
              style={{
                padding: index === 0 ? "15px 16px 9px 0" : "9px 16px 9px 0",
                borderTop: index === 0 ? "none" : "1px solid #e2e8f0",
                color: "#425466",
                fontSize: 14,
                lineHeight: 1.55,
                verticalAlign: "top",
              }}
            >
              {item}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
