import { useEffect, useState, useCallback } from 'react'
import {
  Button, Input, Table, Tag, Tabs, Progress, message, Space, Card, Modal, Descriptions, Typography,
} from 'antd'
import {
  SearchOutlined, DownloadOutlined, StopOutlined, ReloadOutlined, CheckCircleOutlined,
  CloseCircleOutlined, SyncOutlined, ClockCircleOutlined,
} from '@ant-design/icons'

const API = '/api/crawler'

interface SearchResult { title: string; url: string; snippet: string }
interface TaskLog { level: string; message: string; time: string }
interface TaskChapter { title: string; url: string; status: string; pages: Array<{ pageNo: number; status: string }> }
interface Task {
  id: string; url: string; site: string; status: string; albumTitle: string;
  chapters: TaskChapter[]; progress: { total: number; done: number; failed: number };
  logs: TaskLog[]; lastError?: string; createdAt: string; updatedAt: string;
}

const STATUS_MAP: Record<string, { color: string; icon: React.ReactNode; text: string }> = {
  created: { color: 'default', icon: <ClockCircleOutlined />, text: '已创建' },
  running: { color: 'processing', icon: <SyncOutlined spin />, text: '运行中' },
  completed: { color: 'green', icon: <CheckCircleOutlined />, text: '已完成' },
  partial_failed: { color: 'warning', icon: <CheckCircleOutlined />, text: '部分失败' },
  failed: { color: 'red', icon: <CloseCircleOutlined />, text: '失败' },
  cancelled: { color: 'orange', icon: <StopOutlined />, text: '已取消' },
}

function App() {
  const [tab, setTab] = useState('search')
  const [keyword, setKeyword] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<SearchResult[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)
  const [logModal, setLogModal] = useState<TaskLog[]>([])
  const [loadingTasks, setLoadingTasks] = useState(false)

  const fetchTasks = useCallback(async () => {
    try {
      const res = await fetch(`${API}/tasks`)
      setTasks(await res.json())
    } catch {}
  }, [])

  useEffect(() => {
    fetchTasks()
    const interval = setInterval(fetchTasks, 3000)
    return () => clearInterval(interval)
  }, [fetchTasks])

  const handleSearch = async () => {
    if (!keyword.trim()) return
    setSearching(true)
    try {
      const res = await fetch(`${API}/search?keyword=${encodeURIComponent(keyword)}&site=jmcomic`)
      const data = await res.json()
      if (data.error) { message.error(data.error); setResults([]) }
      else { setResults(data.results || []) }
    } catch {
      message.error('搜索失败')
    } finally {
      setSearching(false)
    }
  }

  const handleCrawl = async (url: string) => {
    try {
      const res = await fetch(`${API}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, site: 'jmcomic' }),
      })
      const task = await res.json()
      if (task.error) message.error(task.error)
      else { message.success('任务已创建'); fetchTasks(); setTab('tasks') }
    } catch {
      message.error('创建任务失败')
    }
  }

  const handleCancel = async (id: string) => {
    await fetch(`${API}/tasks/${id}/cancel`, { method: 'POST' })
    fetchTasks()
  }

  const showLogs = async (id: string) => {
    const res = await fetch(`${API}/tasks/${id}/logs`)
    setLogModal(await res.json())
  }

  const showDetail = (task: Task) => setSelectedTask(task)

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: 24 }}>
      <Typography.Title level={3} style={{ color: '#FF9F2F' }}>
        <DownloadOutlined /> CatComic Crawler
      </Typography.Title>

      <Tabs activeKey={tab} onChange={setTab} items={[
        {
          key: 'search',
          label: '搜索漫画',
          children: (
            <Card>
              <Space.Compact style={{ width: '100%', marginBottom: 16 }}>
                <Input
                  allowClear
                  size="large"
                  placeholder="搜索 18comic.vip (Google site search)..."
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  onPressEnter={handleSearch}
                  prefix={<SearchOutlined />}
                />
                <Button type="primary" size="large" loading={searching} onClick={handleSearch}>
                  搜索
                </Button>
              </Space.Compact>

              {results.map((r, i) => (
                <Card key={i} size="small" style={{ marginBottom: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <strong>{r.title}</strong>
                      <div style={{ color: '#666', fontSize: 12 }}>{r.snippet}</div>
                      <a href={r.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12 }}>
                        {r.url}
                      </a>
                    </div>
                    <Button type="primary" icon={<DownloadOutlined />} onClick={() => handleCrawl(r.url)}>
                      爬取
                    </Button>
                  </div>
                </Card>
              ))}

              {!searching && results.length === 0 && keyword && (
                <div style={{ textAlign: 'center', color: '#999', padding: 40 }}>
                  未找到结果，请尝试其他关键词
                </div>
              )}
            </Card>
          ),
        },
        {
          key: 'tasks',
          label: `任务 (${tasks.length})`,
          children: (
            <Table<Task>
              dataSource={tasks}
              rowKey="id"
              size="small"
              columns={[
                {
                  title: '状态', dataIndex: 'status', width: 110,
                  render: (s: string) => {
                    const m = STATUS_MAP[s] || { color: 'default', text: s }
                    return <Tag color={m.color} icon={m.icon}>{m.text}</Tag>
                  },
                },
                {
                  title: '漫画', dataIndex: 'albumTitle', ellipsis: true,
                  render: (t: string, r: Task) => t || r.url.substring(0, 40) + '...',
                },
                {
                  title: '进度', width: 200,
                  render: (_: unknown, r: Task) => {
                    const pct = r.progress.total > 0 ? Math.round((r.progress.done / r.progress.total) * 100) : 0
                    return <Progress percent={pct} size="small" format={() => `${r.progress.done}/${r.progress.total}`} />
                  },
                },
                { title: '创建时间', dataIndex: 'createdAt', width: 160, render: (t: string) => t?.substring(0, 16) },
                {
                  title: '操作', width: 200,
                  render: (_: unknown, r: Task) => (
                    <Space>
                      <Button size="small" onClick={() => showDetail(r)}>详情</Button>
                      <Button size="small" onClick={() => showLogs(r.id)}>日志</Button>
                      {r.status === 'running' && (
                        <Button size="small" danger icon={<StopOutlined />} onClick={() => handleCancel(r.id)}>取消</Button>
                      )}
                    </Space>
                  ),
                },
              ]}
            />
          ),
        },
      ]} />

      {/* Task detail modal */}
      <Modal
        title="任务详情"
        open={!!selectedTask}
        onCancel={() => setSelectedTask(null)}
        footer={null}
        width={700}
        destroyOnHidden
      >
        {selectedTask && (
          <Descriptions column={2} bordered size="small">
            <Descriptions.Item label="ID">{selectedTask.id?.substring(0, 20)}</Descriptions.Item>
            <Descriptions.Item label="状态">
              <Tag color={STATUS_MAP[selectedTask.status]?.color}>{STATUS_MAP[selectedTask.status]?.text}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="标题" span={2}>{selectedTask.albumTitle}</Descriptions.Item>
            <Descriptions.Item label="URL" span={2}>{selectedTask.url}</Descriptions.Item>
            <Descriptions.Item label="章节">{selectedTask.progress.done}/{selectedTask.progress.total}</Descriptions.Item>
            <Descriptions.Item label="失败">{selectedTask.progress.failed}</Descriptions.Item>
            {selectedTask.lastError && (
              <Descriptions.Item label="错误" span={2}><span style={{ color: 'red' }}>{selectedTask.lastError}</span></Descriptions.Item>
            )}
          </Descriptions>
        )}
      </Modal>

      {/* Logs modal */}
      <Modal title="日志" open={logModal.length > 0} onCancel={() => setLogModal([])} footer={null} width={700}>
        <div style={{ maxHeight: 400, overflow: 'auto', fontFamily: 'monospace', fontSize: 12 }}>
          {logModal.map((l, i) => (
            <div key={i} style={{
              color: l.level === 'error' ? 'red' : l.level === 'warn' ? 'orange' : '#333',
              padding: '2px 0', borderBottom: '1px solid #f0f0f0',
            }}>
              <span style={{ color: '#999' }}>{l.time?.substring(11, 19)}</span> {l.message}
            </div>
          ))}
        </div>
      </Modal>
    </div>
  )
}

export default App
