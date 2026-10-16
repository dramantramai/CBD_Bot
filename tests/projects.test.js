const { createProject, findByName, addVersion, getVersions, getProject, setLocation, slug, fileNameFor, nextFileName, listProjects } = require('../src/db/projects');
const { getDb } = require('../src/db/connection');

beforeEach(() => {
  getDb().prepare('DELETE FROM project_versions').run();
  getDb().prepare('DELETE FROM projects').run();
});

describe('naming a project and its files', () => {
  it.each([
    ['Verdant Kitchens', 'VerdantKitchens'],
    ['verdant kitchens', 'VerdantKitchens'],
    ['AI newsletter-design', 'AINewsletterDesign'],
    ['  Orange   Lab / Event!  ', 'OrangeLabEvent'],
    ['Café Déjà vu', 'CaféDéjàVu'],
  ])('writes "%s" as %s', (input, expected) => expect(slug(input)).toBe(expected));

  it('names a version after its project, then _v and the number', () => {
    const p = createProject({ clientName: 'Verdant Kitchens', projectName: 'Video' });
    expect(fileNameFor(p, 1)).toBe('VerdantKitchens_Video_v1.docx');
    expect(nextFileName(p)).toBe('VerdantKitchens_Video_v1.docx');
  });
});

describe('the project record', () => {
  it('needs both names', () => {
    expect(() => createProject({ clientName: 'Verdant', projectName: '  ' })).toThrow(/client name and a project name/);
    expect(() => createProject({ clientName: '!!!', projectName: 'Video' })).toThrow(/client name and a project name/);
  });

  it('refuses the same client and project twice, whatever the capitalisation, since files are named from them', () => {
    createProject({ clientName: 'Verdant Kitchens', projectName: 'Video' });
    expect(() => createProject({ clientName: 'verdant kitchens', projectName: 'VIDEO' })).toThrow(/already exists/);
    expect(findByName('VERDANT KITCHENS', 'video')).not.toBeNull();
  });

  it('treats names that make the same chat and file names as the same project, however they are spelled', () => {
    createProject({ clientName: 'Verdant Kitchens', projectName: 'Social Media' });
    expect(() => createProject({ clientName: 'Verdant-Kitchens', projectName: 'social  media' })).toThrow(/already exists/);
    expect(findByName('VerdantKitchens', 'SocialMedia')).not.toBeNull();
  });

  it('allows the same client a second project', () => {
    createProject({ clientName: 'Verdant Kitchens', projectName: 'Video' });
    expect(() => createProject({ clientName: 'Verdant Kitchens', projectName: 'Website' })).not.toThrow();
    expect(listProjects()).toHaveLength(2);
  });

  it('remembers where the chat and folder are, without losing what was set before', () => {
    const p = createProject({ clientName: 'Verdant', projectName: 'Video' });
    setLocation(p.id, { chatId: '19:abc', folderBackend: 'onedrive', folderOwner: 'u1', folderName: 'Verdant_Video' });
    const after = setLocation(p.id, { chatId: '19:def' });
    expect(after).toMatchObject({ chat_id: '19:def', folder_backend: 'onedrive', folder_owner: 'u1', folder_name: 'Verdant_Video' });
  });
});

describe('versions', () => {
  it('numbers versions from the record and never reuses or replaces one', () => {
    const p = createProject({ clientName: 'Verdant Kitchens', projectName: 'Video' });
    expect(addVersion(p.id, { backend: 'onedrive', fileRef: 'a' })).toEqual({ version: 1, fileName: 'VerdantKitchens_Video_v1.docx' });
    expect(addVersion(p.id, { backend: 'onedrive', fileRef: 'b', sourceMeetingId: 'm2' })).toEqual({ version: 2, fileName: 'VerdantKitchens_Video_v2.docx' });

    expect(getProject(p.id).current_version).toBe(2);
    expect(getVersions(p.id).map((v) => [v.version, v.file_ref, v.backend])).toEqual([[1, 'a', 'onedrive'], [2, 'b', 'onedrive']]);
  });

  it('keeps which backend wrote each version, so switching storage never orphans an old one', () => {
    const p = createProject({ clientName: 'Verdant', projectName: 'Video' });
    addVersion(p.id, { backend: 'onedrive', fileRef: 'a' });
    addVersion(p.id, { backend: 'sharepoint', fileRef: 'b' });
    expect(getVersions(p.id).map((v) => v.backend)).toEqual(['onedrive', 'sharepoint']);
  });

  it('refuses a version for a project that does not exist', () => {
    expect(() => addVersion('nope', { backend: 'onedrive' })).toThrow(/No project/);
  });
});
