import { useState, useRef, useEffect } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { TodoTask } from '../../shared/types';

interface Props {
  task: TodoTask;
  onDelete: (id: string) => void;
  onComplete: (id: string) => void;
  onEdit: (id: string, text: string) => void;
  isLast?: boolean;
  variant?: 'todo' | 'daily';
}

function formatTime(seconds?: number): string | null {
  if (!seconds) return null;
  if (seconds < 60) return '<1m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function SortableTaskItem({ task, onDelete, onComplete, onEdit, isLast, variant = 'todo' }: Props) {
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(task.text);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isEditing]);

  function handleSave() {
    if (editText.trim() && editText !== task.text) {
      onEdit(task.id, editText.trim());
    } else {
      setEditText(task.text);
    }
    setIsEditing(false);
  }

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 1 : 0,
    position: 'relative',
    boxShadow: isDragging ? '0 4px 12px rgba(0,0,0,0.5)' : 'none',
  };

  return (
    <div ref={setNodeRef} style={{ ...style, ...styles.taskItem, ...(isLast ? { marginBottom: 0 } : {}) }}>
      <div {...attributes} {...listeners} style={styles.dragHandle}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="9" cy="12" r="1"></circle>
          <circle cx="9" cy="5" r="1"></circle>
          <circle cx="9" cy="19" r="1"></circle>
          <circle cx="15" cy="12" r="1"></circle>
          <circle cx="15" cy="5" r="1"></circle>
          <circle cx="15" cy="19" r="1"></circle>
        </svg>
      </div>
      
      <div style={styles.taskContent}>
        {isEditing ? (
          <input
            ref={inputRef}
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onBlur={handleSave}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave();
              if (e.key === 'Escape') {
                setEditText(task.text);
                setIsEditing(false);
              }
            }}
            style={styles.editInput}
          />
        ) : (
          <>
            <span 
              style={styles.taskText} 
              onClick={() => setIsEditing(true)} 
              title="Click to edit"
            >
              {task.text}
            </span>
            {task.timeSpentSeconds ? (
              <span 
                style={styles.timeSpent}
                title={task.actualStartTime ? `Started: ${new Date(task.actualStartTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : undefined}
              >
                {formatTime(task.timeSpentSeconds)}
              </span>
            ) : null}
          </>
        )}
      </div>

      <div style={styles.actions}>
        <button
          onClick={() => onComplete(task.id)}
          style={styles.actionBtn}
          title={variant === 'daily' ? "Add to Todo" : "Mark as Done"}
          onMouseEnter={(e) => (e.currentTarget.style.color = variant === 'daily' ? '#6b9eff' : '#4ade80')}
          onMouseLeave={(e) => (e.currentTarget.style.color = '#8888aa')}
        >
          {variant === 'daily' ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          )}
        </button>
        <button
          onClick={() => onDelete(task.id)}
          style={styles.actionBtn}
          title="Delete Task"
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
  );
}

const styles: Record<string, React.CSSProperties> = {
  taskItem: {
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
  dragHandle: {
    cursor: 'grab',
    color: '#666688',
    display: 'flex',
    alignItems: 'center',
    padding: '4px',
    marginLeft: '-4px',
  },
  taskContent: {
    flex: 1,
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  taskText: {
    fontSize: 12,
    color: '#e0e0e0',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    display: 'block',
    outline: 'none',
    flex: 1,
  },
  timeSpent: {
    fontSize: 11,
    color: '#4ade80',
    fontWeight: 'bold',
    flexShrink: 0,
  },
  editInput: {
    width: '100%',
    fontSize: 12,
    color: '#e0e0e0',
    background: '#1a1a2e',
    border: '1px solid #4f6ef7',
    borderRadius: 4,
    padding: '2px 4px',
    outline: 'none',
    boxSizing: 'border-box',
  },
  actions: {
    display: 'flex',
    gap: 4,
  },
  actionBtn: {
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
