import { ipcMain, dialog } from 'electron'
import { splitFilePathsIntoChapters } from '../chapter-splitting'

/**
 * 导入小说控制器 — 处理文件选择与章节拆分
 *
 * 拆章规则统一放在 ../chapter-splitting.ts，
 * 与「拆书知识库」共用同一套规则，避免两处实现漂移。
 */
export function registerImportController() {
  // ===== 文件选择对话框 =====
  ipcMain.handle('dialog:select-novel-files', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择要导入的小说文件',
      filters: [
        { name: '小说文本', extensions: ['txt', 'md', 'text'] },
        { name: '所有文件', extensions: ['*'] },
      ],
      properties: ['openFile', 'multiSelections'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths
  })

  // ===== 读取并拆分章节 =====
  ipcMain.handle('import:split-chapters', async (_event, filePaths: string[]) => {
    return splitFilePathsIntoChapters(filePaths)
  })
}
