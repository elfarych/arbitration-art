import { ChangeDetectionStrategy, Component } from '@angular/core';

import { BotListComponent } from '../bots/bot-list.component';

@Component({
  selector: 'app-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BotListComponent],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent {}
