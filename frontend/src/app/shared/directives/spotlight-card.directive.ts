import {
  Directive,
  ElementRef,
  NgZone,
  OnDestroy,
  OnInit,
  inject,
} from '@angular/core';

/**
 * SpotlightCard — Windows-style border-glow hover effect.
 *
 * Apply `spotlightCard` to any card element. On hover, a radial gradient
 * border glow tracks the cursor position relative to that element via
 * `--sx` and `--sy` CSS custom properties.
 *
 * The visual is driven entirely by CSS (see `.spotlight-card` in styles.scss),
 * so this directive only updates two CSS variables — no Angular CD cycles.
 *
 * ## Usage
 * ```html
 * <div spotlightCard class="spotlight-card">...</div>
 * ```
 */
@Directive({
  selector: '[spotlightCard]',
  standalone: true,
})
export class SpotlightCardDirective implements OnInit, OnDestroy {
  private readonly el = inject(ElementRef<HTMLElement>);
  private readonly zone = inject(NgZone);

  private moveHandler!: (e: MouseEvent) => void;
  private enterHandler!: () => void;
  private leaveHandler!: () => void;

  ngOnInit(): void {
    const el = this.el.nativeElement;

    this.zone.runOutsideAngular(() => {
      this.moveHandler = (e: MouseEvent) => {
        const rect = el.getBoundingClientRect();
        // Matches the CSS var names used in the .spotlight-card ::before / ::after rules.
        el.style.setProperty('--mouse-x', `${e.clientX - rect.left}px`);
        el.style.setProperty('--mouse-y', `${e.clientY - rect.top}px`);
      };

      this.enterHandler = () => {
        el.style.setProperty('--glow-opacity', '1');
      };

      this.leaveHandler = () => {
        el.style.setProperty('--glow-opacity', '0');
      };

      el.addEventListener('mousemove', this.moveHandler, { passive: true });
      el.addEventListener('mouseenter', this.enterHandler, { passive: true });
      el.addEventListener('mouseleave', this.leaveHandler, { passive: true });
    });
  }

  ngOnDestroy(): void {
    const el = this.el.nativeElement;
    el.removeEventListener('mousemove', this.moveHandler);
    el.removeEventListener('mouseenter', this.enterHandler);
    el.removeEventListener('mouseleave', this.leaveHandler);
  }
}
