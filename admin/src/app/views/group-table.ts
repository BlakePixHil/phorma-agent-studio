import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { OTHER_GROUP_LABEL, type GroupRow } from '../core/models';
import { metricOf } from './view-data';

/** One numeric column of a group table. `key` indexes into the row. */
export interface GroupColumn {
  key: string;
  label: string;
}

/** Just the install count, which every grouped route reports. */
export const INSTALLS_COLUMN: readonly GroupColumn[] = [{ key: 'installs', label: 'Installs' }];

/**
 * One grouped aggregate as a table.
 *
 * Geography needs two of these, environment four, features and trend one each,
 * so the markup lives once. A plain `<table>` rather than `p-table`: these are
 * short, unsorted, unpaged aggregates, and the PrimeNG table would add weight
 * and a control whose size has to be managed for no gain.
 *
 * The `other` row is rendered, not hidden - it is where the Worker's k-anonymity
 * floor put every group below the threshold, and dropping it would silently lose
 * its metrics. It is marked so it does not read as a real group.
 */
@Component({
  selector: 'admin-group-table',
  imports: [DecimalPipe],
  template: `
    <article class="admin-card">
      <h3 class="admin-card__title">
        <i class="ti {{ icon() }}" aria-hidden="true"></i>
        <span>{{ title() }}</span>
      </h3>

      <table class="admin-table">
        <caption class="admin-table__caption">
          {{ title() }}
        </caption>
        <thead>
          <tr>
            <th scope="col">{{ labelHeading() }}</th>
            @for (column of columns(); track column.key) {
              <th scope="col" class="admin-table__number">{{ column.label }}</th>
            }
          </tr>
        </thead>
        <tbody>
          @for (row of rows(); track row.label) {
            <tr>
              <th scope="row" class="admin-table__label">
                <span>{{ row.label }}</span>
                @if (row.label === otherLabel) {
                  <span class="admin-table__fold" title="Groups below the reporting threshold">
                    folded
                  </span>
                }
              </th>
              @for (column of columns(); track column.key) {
                <td class="admin-table__number">{{ metric(row, column.key) | number }}</td>
              }
            </tr>
          }
        </tbody>
      </table>
    </article>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GroupTable {
  readonly title = input.required<string>();
  readonly rows = input.required<readonly GroupRow[]>();

  /** Tabler icon class for the card heading. */
  readonly icon = input('ti-list');

  /** Heading of the label column, naming what the rows are grouped by. */
  readonly labelHeading = input('Group');

  /** The numeric columns, in render order. */
  readonly columns = input<readonly GroupColumn[]>(INSTALLS_COLUMN);

  /** The label the Worker folds sub-threshold groups under. */
  readonly otherLabel = OTHER_GROUP_LABEL;

  metric(row: GroupRow, key: string): number {
    return metricOf(row, key);
  }
}
