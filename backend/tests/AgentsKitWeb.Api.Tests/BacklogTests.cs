using AgentsKitWeb.Api.Workspaces;

namespace AgentsKitWeb.Api.Tests;

public class BacklogTests
{
    // Переводы строк приводятся к LF: при core.autocrlf=true сырая строка в исходнике получает CRLF.
    private static readonly string File = """
        # Проект — бэклог

        <!-- Что стоит сделать и сейчас не в работе. -->

        следующий номер: B-17

        ## B-1 Панель показывает проблемы баз знаний

        Сейчас панель не говорит, что с базой что-то не так.

        Предлагается показывать проблемы прямо в панели.

        ### Агенту
        - в таблице — колонка Issues
        - где: design/sketch.html

        ## B-8 Панель показывает бэклог базы

        Бэклог сейчас виден только в файле базы.

        ### Агенту
        - читать с диска на каждый запрос

        ## Запись без номера

        Её дописали руками.
        """.ReplaceLineEndings("\n");

    [Fact]
    public void Parse_ReadsNumberTitleAndOperatorText()
    {
        var entries = Backlog.Parse(File);

        Assert.Equal(["B-1", "B-8", null], entries.Select(e => e.Number));
        Assert.Equal("Панель показывает проблемы баз знаний", entries[0].Title);
        Assert.Equal(
            "Сейчас панель не говорит, что с базой что-то не так.\n\nПредлагается показывать проблемы прямо в панели.",
            entries[0].Text);
    }

    [Fact]
    public void Parse_DropsAgentPart()
    {
        var entries = Backlog.Parse(File);

        Assert.DoesNotContain(entries, e => e.Text is not null && e.Text.Contains("колонка Issues"));
        Assert.Equal("Бэклог сейчас виден только в файле базы.", entries[1].Text);
    }

    [Fact]
    public void Parse_KeepsEntryWithoutNumberAsTitle()
    {
        var entry = Backlog.Parse(File)[2];

        Assert.Null(entry.Number);
        Assert.Equal("Запись без номера", entry.Title);
        Assert.Equal("Её дописали руками.", entry.Text);
    }

    [Fact]
    public void Parse_ReadsCyrillicNumberAsSameNumber()
    {
        var entry = Backlog.Parse("## В-7 Запись руками оператора\n\nТекст.\n")[0];

        Assert.Equal("В-7", entry.Number);
        Assert.Equal("Запись руками оператора", entry.Title);
    }

    [Fact]
    public void Parse_ReturnsNothingForHeaderOnlyFile()
    {
        Assert.Empty(Backlog.Parse("# Проект — бэклог\n\nследующий номер: B-1\n"));
    }

    [Fact]
    public void Parse_KeepsEntryWithoutText()
    {
        var entry = Backlog.Parse("## B-2 Одним заголовком\n\n### Агенту\n- где: нигде\n")[0];

        Assert.Equal("B-2", entry.Number);
        Assert.Null(entry.Text);
    }
}
