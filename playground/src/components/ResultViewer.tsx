interface ResultViewerProps {
  data: unknown
  error: string | null
  loading: boolean
  label?: string
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return value
  if (typeof value === 'bigint') return value.toString()
  return JSON.stringify(value, null, 2)
}

function JsonNode({ data, depth = 0 }: { data: unknown; depth?: number }) {
  if (data === null) return <span className="text-gray-500">null</span>
  if (data === undefined) return <span className="text-gray-500">undefined</span>

  if (typeof data === 'boolean') {
    return <span className={data ? 'text-green-400' : 'text-red-400'}>{String(data)}</span>
  }

  if (typeof data === 'number') {
    return <span className="text-yellow-300">{data}</span>
  }

  if (typeof data === 'string') {
    if (data.startsWith('0x') || data.startsWith('npub') || data.startsWith('nsec')) {
      return (
        <span className="text-emerald-400 break-all">
          &quot;{data}&quot;
        </span>
      )
    }
    return <span className="text-orange-300">&quot;{data}&quot;</span>
  }

  if (Array.isArray(data)) {
    if (data.length === 0) return <span className="text-gray-400">[]</span>
    return (
      <span>
        <span className="text-gray-400">[</span>
        <div className="ml-4">
          {data.map((item, i) => (
            <div key={i}>
              <JsonNode data={item} depth={depth + 1} />
              {i < data.length - 1 && <span className="text-gray-600">,</span>}
            </div>
          ))}
        </div>
        <span className="text-gray-400">]</span>
      </span>
    )
  }

  if (typeof data === 'object') {
    const entries = Object.entries(data as Record<string, unknown>)
    if (entries.length === 0) return <span className="text-gray-400">{'{}'}</span>
    return (
      <span>
        <span className="text-gray-400">{'{'}</span>
        <div className="ml-4">
          {entries.map(([key, val], i) => (
            <div key={key}>
              <span className="text-blue-300">&quot;{key}&quot;</span>
              <span className="text-gray-400">: </span>
              <JsonNode data={val} depth={depth + 1} />
              {i < entries.length - 1 && <span className="text-gray-600">,</span>}
            </div>
          ))}
        </div>
        <span className="text-gray-400">{'}'}</span>
      </span>
    )
  }

  return <span className="text-gray-300">{formatValue(data)}</span>
}

const ResultViewer = ({ data, error, loading, label }: ResultViewerProps) => {
  if (loading) {
    return (
      <div className="card p-4 mt-2">
        <div className="flex items-center gap-2 text-yellow-400 text-sm">
          <span className="animate-spin inline-block w-3 h-3 border border-yellow-400 border-t-transparent rounded-full" />
          <span>Loading...</span>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="card p-4 mt-2 border-red-900/50 bg-red-950/20">
        {label && <div className="text-xs text-gray-500 mb-1">{label}</div>}
        <div className="text-red-400 text-sm font-mono break-all">{error}</div>
      </div>
    )
  }

  if (data === null || data === undefined) return null

  return (
    <div className="card p-4 mt-2">
      {label && <div className="text-xs text-gray-500 mb-2">{label}</div>}
      <pre className="mono text-xs text-gray-300 overflow-auto max-h-64 leading-relaxed">
        <JsonNode data={data} />
      </pre>
    </div>
  )
}

export default ResultViewer
