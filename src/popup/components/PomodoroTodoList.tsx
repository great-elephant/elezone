import { useState } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { TodoTask } from '../../shared/types';
import { SortableTaskItem } from './SortableTaskItem';

interface Props {
  tasks: TodoTask[];
  doneTasks: TodoTask[];
  dailyTasks?: TodoTask[];
  onTasksChange: (tasks: TodoTask[]) => void;
  onDoneTasksChange: (tasks: TodoTask[]) => void;
  onDailyTasksChange?: (tasks: TodoTask[]) => void;
  onCompleteTask?: (id: string) => void;
  onRevertTask?: (id: string) => void;
  onStartFocus?: (id: string) => void;
}

const TASK_ITEM_HEIGHT = 36;
const TASK_ITEM_GAP = 6;
const MAX_VISIBLE_TASKS = 4;
const MAX_VISIBLE_DONE_TASKS = MAX_VISIBLE_TASKS + 1;
const taskListMaxHeight = (visibleTasks: number) => visibleTasks * TASK_ITEM_HEIGHT + (visibleTasks - 1) * TASK_ITEM_GAP;
const TASK_LIST_MAX_HEIGHT = taskListMaxHeight(MAX_VISIBLE_TASKS);
const DONE_LIST_MAX_HEIGHT = taskListMaxHeight(MAX_VISIBLE_DONE_TASKS);

function formatTime(seconds: number): string {
  if (!seconds || seconds < 60) return '<1m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function PomodoroTodoList({ tasks, doneTasks, dailyTasks, onTasksChange, onDoneTasksChange, onDailyTasksChange, onCompleteTask, onRevertTask, onStartFocus }: Props) {
  const [activeTab, setActiveTab] = useState<'todo' | 'daily' | 'done'>('todo');
  const [inputValue, setInputValue] = useState('');

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  function handleAddDailyToTodo(task: TodoTask) {
    if (!tasks.some(t => t.text === task.text)) {
      onTasksChange([...tasks, { ...task, id: crypto.randomUUID() }]);
    }
  }

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const text = inputValue.trim();
    if (!text) return;

    const newTask: TodoTask = {
      id: crypto.randomUUID(),
      text,
      createdAt: Date.now(),
    };

    if (activeTab === 'daily') {
      if (onDailyTasksChange) onDailyTasksChange([...(dailyTasks || []), newTask]);
    } else {
      onTasksChange([...tasks, newTask]);
    }
    setInputValue('');
  }

  function handleDelete(id: string) {
    if (activeTab === 'daily') {
      if (onDailyTasksChange) onDailyTasksChange((dailyTasks || []).filter((t) => t.id !== id));
    } else {
      onTasksChange(tasks.filter((t) => t.id !== id));
    }
  }

  function handleEdit(id: string, text: string) {
    if (activeTab === 'daily') {
      if (onDailyTasksChange) onDailyTasksChange((dailyTasks || []).map((t) => (t.id === id ? { ...t, text } : t)));
    } else {
      onTasksChange(tasks.map((t) => (t.id === id ? { ...t, text } : t)));
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      if (activeTab === 'daily') {
        const list = dailyTasks || [];
        const oldIndex = list.findIndex((t) => t.id === active.id);
        const newIndex = list.findIndex((t) => t.id === over.id);
        if (onDailyTasksChange) onDailyTasksChange(arrayMove(list, oldIndex, newIndex));
      } else {
        const oldIndex = tasks.findIndex((t) => t.id === active.id);
        const newIndex = tasks.findIndex((t) => t.id === over.id);
        onTasksChange(arrayMove(tasks, oldIndex, newIndex));
      }
    }
  }

  return (
    <div style={styles.container}>
      <style>{`
        .pomodoro-task-list::-webkit-scrollbar {
          width: 2px;
        }
        .pomodoro-task-list::-webkit-scrollbar-track {
          background: transparent;
        }
        .pomodoro-task-list::-webkit-scrollbar-thumb {
          background: #3a3a5a;
          border-radius: 4px;
        }
        .pomodoro-task-list::-webkit-scrollbar-thumb:hover {
          background: #4a4a6a;
        }
        .pomodoro-task-list > div:last-child {
          margin-bottom: 0 !important;
        }
      `}</style>
      <div style={styles.expandedView}>
        <div style={styles.tabContainer}>
          <button
            style={{ ...styles.tabBtn, ...(activeTab === 'todo' ? styles.activeTabBtn : {}) }}
            onClick={() => setActiveTab('todo')}
          >
            Todo ({tasks.length})
          </button>
          <button
            style={{ ...styles.tabBtn, ...(activeTab === 'done' ? styles.activeTabBtn : {}) }}
            onClick={() => setActiveTab('done')}
          >
            Done ({doneTasks.length})
          </button>
          <button
            style={{ ...styles.tabBtn, ...(activeTab === 'daily' ? styles.activeTabBtn : {}) }}
            onClick={() => setActiveTab('daily')}
          >
            Daily ({dailyTasks?.length || 0})
          </button>
          {activeTab === 'done' && doneTasks.length > 0 && (
            <button
              onClick={() => onDoneTasksChange([])}
              style={styles.clearBtn}
              title="Clear all done tasks"
            >
              Clear All
            </button>
          )}
          {activeTab === 'daily' && dailyTasks && dailyTasks.length > 0 && (
            <button
              onClick={() => {
                const newTasks = [...tasks];
                let added = false;
                dailyTasks.forEach(dt => {
                  if (!newTasks.some(t => t.text === dt.text)) {
                    newTasks.push({ ...dt, id: crypto.randomUUID(), createdAt: Date.now() });
                    added = true;
                  }
                });
                if (added) onTasksChange(newTasks);
              }}
              style={styles.addAllBtn}
              title="Add all to Todo"
            >
              Add All
            </button>
          )}
        </div>

        {(activeTab === 'todo' || activeTab === 'daily') && (
          <form onSubmit={handleAdd} style={styles.inputForm}>
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={activeTab === 'todo' ? "Quick add task..." : "Quick add daily template..."}
              style={styles.input}
              autoFocus
            />
            <button type="submit" style={styles.addBtn} disabled={!inputValue.trim()}>
              +
            </button>
          </form>
        )}

        <div
          className="pomodoro-task-list"
          style={{
            ...styles.taskList,
            maxHeight: `${activeTab === 'done' ? DONE_LIST_MAX_HEIGHT : TASK_LIST_MAX_HEIGHT}px`,
          }}
        >
          {activeTab === 'todo' || activeTab === 'daily' ? (
            (activeTab === 'todo' ? tasks : (dailyTasks || [])).length === 0 ? (
              <div style={styles.emptyState}>
                {activeTab === 'todo' ? 'Your deck is empty. Add a task to focus on.' : 'No daily templates yet. Add some here.'}
              </div>
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={(activeTab === 'todo' ? tasks : (dailyTasks || [])).map((t) => t.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {(activeTab === 'todo' ? tasks : (dailyTasks || [])).map((task, index, arr) => (
                    <SortableTaskItem
                      key={task.id}
                      task={task}
                      onDelete={handleDelete}
                      onComplete={(id) => {
                        if (activeTab === 'daily') {
                          handleAddDailyToTodo(task);
                        } else {
                          onCompleteTask ? onCompleteTask(id) : handleDelete(id);
                        }
                      }}
                      onEdit={handleEdit}
                      onStartFocus={onStartFocus}
                      isLast={index === arr.length - 1}
                      variant={activeTab === 'todo' ? 'todo' : 'daily'}
                    />
                  ))}
                </SortableContext>
              </DndContext>
            )
          ) : (
            doneTasks.length === 0 ? (
              <div style={styles.emptyState}>No completed tasks yet.</div>
            ) : (
              doneTasks.map((task, index) => (
                <div key={task.id} style={{ ...styles.doneItem, ...(index === doneTasks.length - 1 ? { marginBottom: 0 } : {}) }}>
                  <div style={styles.doneContent}>
                    <span style={styles.doneText} title={task.text}>{task.text}</span>
                    <span 
                      style={styles.doneTime}
                      title={(task.actualStartTime || task.completedAt) ? `${task.actualStartTime ? new Date(task.actualStartTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--'} - ${task.completedAt ? new Date(task.completedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--'}` : undefined}
                    >
                      {formatTime(task.timeSpentSeconds || 0)}
                    </span>
                  </div>
                  <div style={styles.actionBtns}>
                    <button
                      onClick={() => onRevertTask && onRevertTask(task.id)}
                      style={styles.iconBtn}
                      title="Move back to Todo"
                      onMouseEnter={(e) => (e.currentTarget.style.color = '#4f6ef7')}
                      onMouseLeave={(e) => (e.currentTarget.style.color = '#8888aa')}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="9 14 4 9 9 4"></polyline>
                        <path d="M20 20v-7a4 4 0 0 0-4-4H4"></path>
                      </svg>
                    </button>
                    <button
                      onClick={() => onDoneTasksChange(doneTasks.filter(t => t.id !== task.id))}
                      style={styles.iconBtn}
                      title="Delete"
                      onMouseEnter={(e) => (e.currentTarget.style.color = '#ef4444')}
                      onMouseLeave={(e) => (e.currentTarget.style.color = '#8888aa')}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                      </svg>
                    </button>
                  </div>
                </div>
              ))
            )
          )}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
  },
  expandedView: {
    background: '#141424',
    borderRadius: '8px',
    border: '1px solid #2a2a4a',
    padding: '8px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  tabContainer: {
    display: 'flex',
    gap: '4px',
    alignItems: 'center',
    borderBottom: '1px solid #3a3a5a',
    paddingBottom: '4px',
    marginBottom: '4px',
  },
  tabBtn: {
    background: 'none',
    border: 'none',
    color: '#666688',
    fontSize: '11px',
    fontWeight: 'bold',
    textTransform: 'uppercase',
    cursor: 'pointer',
    padding: '4px 8px',
    borderRadius: '4px',
  },
  activeTabBtn: {
    color: '#8888aa',
    background: '#2a2a4a',
  },
  clearBtn: {
    background: 'none',
    border: 'none',
    color: '#ef4444',
    fontSize: '10px',
    cursor: 'pointer',
    padding: '2px 6px',
    fontWeight: 'bold',
    marginLeft: 'auto',
  },
  addAllBtn: {
    background: 'none',
    border: 'none',
    color: '#4f6ef7',
    fontSize: '10px',
    cursor: 'pointer',
    padding: '2px 6px',
    fontWeight: 'bold',
    marginLeft: 'auto',
  },
  inputForm: {
    display: 'flex',
    gap: '6px',
    height: '34px',
  },
  input: {
    flex: 1,
    background: '#2a2a4a',
    border: '1px solid #3a3a5a',
    borderRadius: '6px',
    padding: '0 10px',
    color: '#fff',
    fontSize: '12px',
    outline: 'none',
    boxSizing: 'border-box',
    height: '100%',
  },
  addBtn: {
    background: '#4f6ef7',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    width: '34px',
    height: '100%',
    cursor: 'pointer',
    fontSize: '18px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    boxSizing: 'border-box',
  },

  taskList: {
    overflowX: 'hidden',
    overflowY: 'auto',
    paddingRight: '2px',
  },
  emptyState: {
    fontSize: '12px',
    color: '#666688',
    textAlign: 'center',
    padding: '12px 0',
  },
  doneItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 8px',
    background: '#2a2a4a',
    borderRadius: 6,
    border: '1px solid #3a3a5a',
    marginBottom: 6,
    height: '36px',
    boxSizing: 'border-box',
  },
  doneContent: {
    flex: 1,
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  doneText: {
    fontSize: 12,
    color: '#e0e0e0',
    textDecoration: 'line-through',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    flex: 1,
  },
  doneTime: {
    fontSize: 11,
    color: '#4ade80',
    fontWeight: 'bold',
    flexShrink: 0,
  },
  actionBtns: {
    display: 'flex',
    gap: 4,
    alignItems: 'center',
  },
  iconBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: '#8888aa',
    padding: '4px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 4,
    transition: 'color 0.2s',
  },
};
