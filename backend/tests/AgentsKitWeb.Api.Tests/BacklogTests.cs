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

        Assert.Equal("B-7", entry.Number);
        Assert.Equal("Запись руками оператора", entry.Title);
    }

    [Fact]
    public void Parse_ReadsNumbersWithAnyProjectLetters()
    {
        var entries = Backlog.Parse("## ORD-12 Выгрузка заказов\n\n## ord-13 Строчными\n\n## ТЕХ-4 Кириллицей\n\n## A1-2 С цифрой\n");

        Assert.Equal(["ORD-12", "ORD-13", "TEX-4", "A1-2"], entries.Select(e => e.Number));
        Assert.Equal(["Выгрузка заказов", "Строчными", "Кириллицей", "С цифрой"], entries.Select(e => e.Title));
    }

    [Theory]
    [InlineData("## Про B-24 и B-11")]
    [InlineData("## B-24x Заголовок")]
    [InlineData("## 1B-2 Цифра первой")]
    [InlineData("## ABCDEFGHIJK-2 Букв больше десяти")]
    [InlineData("## Заказ-2 Не латиница")]
    public void Parse_KeepsWordThatIsNotNumberInTitle(string header)
    {
        var entry = Backlog.Parse(header + "\n")[0];

        Assert.Null(entry.Number);
        Assert.Equal(header[3..], entry.Title);
    }

    [Fact]
    public void Letters_ComeFromCounter()
    {
        Assert.Equal("B", Backlog.Letters(File));
        Assert.Equal("ORD", Backlog.Letters("следующий номер: ORD-13\n\n## B-7 Чужими буквами\n"));
        // Счётчик, набранный руками кириллицей и строчными, — те же буквы.
        Assert.Equal("TEX", Backlog.Letters("следующий номер: тех-5\n"));
    }

    [Fact]
    public void Letters_WithoutCounterComeFromHighestNumber()
    {
        Assert.Equal("ORD", Backlog.Letters("## B-3 Чужими буквами\n\n## ORD-12 Своими\n\n## Без номера\n"));
    }

    [Fact]
    public void Letters_AreUnknownWithoutNumbers()
    {
        Assert.Null(Backlog.Letters("# Проект — бэклог\n\n## Без номера\n"));
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

    // Тот же файл, но с полями кита: объявление в шапке и пары под заголовком записи.
    private static readonly string FileWithFields = """
        # Проект — бэклог

        следующий номер: B-17
        поля: приоритет, тип

        ## B-1 Панель показывает проблемы баз знаний

        приоритет: высокий
        тип: баг

        Сейчас панель не говорит, что с базой что-то не так.

        ### Агенту
        - где: design/sketch.html

        ## B-8 Панель показывает бэклог базы

        тип: фича

        Бэклог сейчас виден только в файле базы.
        """.ReplaceLineEndings("\n");

    [Fact]
    public void Parse_ReadsDeclaredFields()
    {
        var entries = Backlog.Parse(FileWithFields);

        Assert.Equal("высокий", entries[0].Priority);
        Assert.Equal("баг", entries[0].Type);
        // Объявленное поле, которого запись не несёт, остаётся пустым
        Assert.Null(entries[1].Priority);
        Assert.Equal("фича", entries[1].Type);
    }

    [Fact]
    public void Parse_KeepsFieldsOutOfOperatorText()
    {
        var entries = Backlog.Parse(FileWithFields);

        Assert.Equal("Сейчас панель не говорит, что с базой что-то не так.", entries[0].Text);
        Assert.Equal("Бэклог сейчас виден только в файле базы.", entries[1].Text);
    }

    [Fact]
    public void Parse_WithoutDeclarationKeepsPairsAsText()
    {
        var file = """
            ## B-1 Без объявления

            приоритет: высокий
            тип: баг

            Текст.
            """.ReplaceLineEndings("\n");

        var entry = Backlog.Parse(file)[0];

        Assert.Null(entry.Priority);
        Assert.Null(entry.Type);
        Assert.Equal("приоритет: высокий\nтип: баг\n\nТекст.", entry.Text);
    }

    [Fact]
    public void Parse_ReadsOnlyDeclaredNames()
    {
        var file = """
            поля: приоритет

            ## B-1 Объявлено одно поле

            приоритет: низкий
            тип: баг

            Текст.
            """.ReplaceLineEndings("\n");

        var entry = Backlog.Parse(file)[0];

        Assert.Equal("низкий", entry.Priority);
        // «тип» шапкой не объявлен, поэтому его строка принадлежит тексту оператору
        Assert.Null(entry.Type);
        Assert.Equal("тип: баг\n\nТекст.", entry.Text);
    }

    [Fact]
    public void Parse_KeepsValueOutsideKitList()
    {
        var file = """
            поля: приоритет, тип

            ## B-1 Значение вне перечня

            приоритет: срочно

            Текст.
            """.ReplaceLineEndings("\n");

        // Панель значения не судит: перечень значений сверяет кит
        Assert.Equal("срочно", Backlog.Parse(file)[0].Priority);
    }

    [Fact]
    public void Parse_TreatsEmptyFieldValueAsMissing()
    {
        var file = """
            поля: приоритет, тип

            ## B-1 Пустое значение

            приоритет:
            тип: баг

            Текст.
            """.ReplaceLineEndings("\n");

        var entry = Backlog.Parse(file)[0];

        Assert.Null(entry.Priority);
        Assert.Equal("баг", entry.Type);
        Assert.Equal("Текст.", entry.Text);
    }

    [Fact]
    public void Parse_KeepsTextLineWithColonAsText()
    {
        var file = """
            поля: приоритет, тип

            ## B-1 Двоеточие в тексте

            Панель: всё плохо.
            """.ReplaceLineEndings("\n");

        Assert.Equal("Панель: всё плохо.", Backlog.Parse(file)[0].Text);
    }

    [Fact]
    public void Parse_ReadsDeclarationOnlyFromFileHeader()
    {
        var file = """
            ## B-1 Объявление внутри записи

            поля: приоритет, тип

            приоритет: высокий
            """.ReplaceLineEndings("\n");

        // Объявление стоит после первой записи, а не в шапке файла: полей у записей нет
        var entry = Backlog.Parse(file)[0];

        Assert.Null(entry.Priority);
        Assert.Equal("поля: приоритет, тип\n\nприоритет: высокий", entry.Text);
    }
}
