import type { AppState } from './types';
import * as ops from './ops';
import { DAY, startOfDay } from './util';

/**
 * Populate a draft with an example plan + goal whose history spans several days,
 * so the Execution Log and Plan Diff have something to show.
 */
export function seedDemo(d: AppState) {
  const realNow = Date.now;
  const today = startOfDay(realNow());
  let T = 0;
  const at = (daysAgo: number, h: number, m: number) => (T = today - daysAgo * DAY + (h * 60 + m) * 60_000);
  const tick = (min: number) => (T += min * 60_000);
  const day = (n: number) => new Date(today + n * DAY).toISOString().slice(0, 10);
  Date.now = () => T;
  try {
    // ── Goal ──
    at(9, 21, 0);
    const g = ops.createGoal(d, '找到适合自己的运动习惯', {
      why: '久坐让下午效率很低，想要更稳定的精力',
      doneWhen: '连续 4 周、每周至少 3 次，而且不觉得是负担',
      cadenceDays: 7,
      nextAction: '试一次晨跑 15 分钟',
    });
    ops.addTask(d, '试一次晨跑 15 分钟');
    ops.addTask(d, '试一节线上瑜伽课');
    at(8, 7, 0);
    ops.setTaskStatus(d, g.moves[0].id, 'active');
    tick(20);
    ops.setTaskStatus(d, g.moves[0].id, 'done');
    at(5, 20, 0);
    ops.setTaskStatus(d, g.moves[1].id, 'active');
    tick(15);
    ops.setTaskStatus(d, g.moves[1].id, 'skipped', '一个人在家坚持不下来');
    at(1, 22, 0);
    ops.addCheckpoint(d, g.id, {
      progress: 20,
      verdict: 'drifting',
      did: '- 晨跑 2 次\n- 瑜伽没坚持下来',
      learned: '早上时间太紧，晚上反而更容易开始',
      next: '今晚下班后快走 20 分钟',
    });

    // ── Plan ──
    at(6, 9, 40);
    const p = ops.createPlan(d, '个人网站改版', '两周内上线新版首页与博客，加载时间 < 1s');
    p.phases = [];
    ops.addPhase(d, '调研', '确定参考站点与内容结构');
    ops.addPhase(d, '设计', '完成首页、博客列表、文章页三页视觉稿');
    ops.addPhase(d, '实现', '首页、博客列表、文章页上线到预览环境');
    const [ph1, ph2, ph3] = p.phases;
    ph1.due = day(-5);
    ph2.due = day(-2);
    ph3.due = day(4);
    ops.addTask(d, '收集 5 个喜欢的个人网站', ph1.id);
    ops.addTask(d, '列出现有内容清单', ph1.id);
    ops.addTask(d, '首页线框图', ph2.id);
    ops.addTask(d, '博客列表页设计', ph2.id);
    ops.addTask(d, '文章页排版', ph2.id);
    ops.addTask(d, '搭建 Astro 项目', ph3.id);
    ops.addTask(d, '首页实现', ph3.id);
    const T_ = (title: string) => p.tasks.find((t) => t.title === title)!.id;

    at(6, 10, 0);
    ops.startSession(d, { intent: '把调研做完', plannedMin: 60, tier: 'sonnet', effort: 'medium' });
    tick(2);
    ops.setTaskStatus(d, T_('收集 5 个喜欢的个人网站'), 'active');
    tick(31);
    ops.setTaskStatus(d, T_('收集 5 个喜欢的个人网站'), 'done');
    ops.setTaskStatus(d, T_('列出现有内容清单'), 'active');
    tick(18);
    ops.setTaskStatus(d, T_('列出现有内容清单'), 'done');
    ops.completePhase(d, ph1.id);
    tick(3);
    ops.endSession(d, { fatigue: 2, outcome: '调研完成，选定 3 个参考站点' });

    at(4, 14, 0);
    ops.startSession(d, { intent: '首页线框图', plannedMin: 60, tier: 'opus', effort: 'high' });
    tick(1);
    ops.setTaskStatus(d, T_('首页线框图'), 'active');
    tick(38);
    ops.addTask(d, '确定字体与配色', ph2.id);
    tick(12);
    ops.setTaskStatus(d, T_('首页线框图'), 'blocked', '等参考图授权确认');
    ops.addNote(d, '线框图需要先定字体，否则来回改');
    tick(4);
    ops.endSession(d, { fatigue: 4 });

    at(3, 9, 30);
    ops.revisePhase(d, ph2.id, '只做首页与文章页的视觉稿，博客列表复用文章页样式', '调研后发现列表页和文章页差异很小，单独设计不划算');
    tick(1);
    ops.deleteTask(d, T_('博客列表页设计'));

    at(1, 20, 0);
    ops.startSession(d, { intent: '收尾线框图，开始定配色', plannedMin: 90, tier: 'sonnet', effort: 'medium' });
    tick(1);
    ops.setTaskStatus(d, T_('首页线框图'), 'active');
    tick(46);
    ops.setTaskStatus(d, T_('首页线框图'), 'done');
    ops.setTaskStatus(d, T_('确定字体与配色'), 'active');
    tick(25);
    ops.deferTask(d, T_('文章页排版'), '先等配色定下来');
    tick(10);
    ops.endSession(d, { fatigue: 3, outcome: '线框图完成，配色还在比较两套方案' });
  } finally {
    Date.now = realNow;
  }
}
