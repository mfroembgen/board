export type DropReason = 'excluded_path' | 'unreadable_project' | 'excluded_target' | 'unimported_target' | 'unsigned' | 'refused_token' | 'direct_message'

export type Drops = {
  record(entry: string, reason: DropReason, detail?: string): void
  exclusions(entry: string, paths: string[]): void
  metrics(): string
}

export function drops(): Drops {
  const dropped = new Map<string, { entry: string; reason: DropReason; count: number }>()
  const excluded = new Map<string, number>()
  return {
    record(entry, reason, detail) {
      const key = `${entry} ${reason}`
      const found = dropped.get(key) ?? { entry, reason, count: 0 }
      dropped.set(key, { ...found, count: found.count + 1 })
      console.info(`[board] ${entry} dropped: ${reason.replaceAll('_', ' ')}${detail ? ` ${detail}` : ''}`)
    },
    exclusions(entry, paths) {
      excluded.set(entry, paths.length)
      console.info(`[board] ${entry} excludes ${paths.length ? paths.join(', ') : 'nothing'}`)
    },
    metrics() {
      return [
        '# HELP board_sync_dropped_total Platform events and deliveries the board dropped, by sync entry and reason.',
        '# TYPE board_sync_dropped_total counter',
        ...[...dropped.values()].map(({ entry, reason, count }) => `board_sync_dropped_total{entry="${entry}",reason="${reason}"} ${count}`),
        '# HELP board_sync_excluded_paths Namespace paths a sync entry keeps off the board.',
        '# TYPE board_sync_excluded_paths gauge',
        ...[...excluded].map(([entry, count]) => `board_sync_excluded_paths{entry="${entry}"} ${count}`),
        '',
      ].join('\n')
    },
  }
}
